import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
	client,
	ndJsonStream,
	PROTOCOL_VERSION,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
	type NewSessionResponse,
} from "@agentclientprotocol/sdk";
import type { Activation } from "../policy.ts";
import { runtimePath } from "../profile.ts";
import { ACP_PROVIDER, assertEnvironment } from "../policy.ts";
import { assertNoSecrets } from "../memory.ts";

export interface AcpPort {
	supportsLoad?: boolean;
	request(method: string, params: any, options?: { signal?: AbortSignal }): Promise<any>;
	notify(method: string, params: any): Promise<void>;
	close(): void;
}
export interface AcpHandlers {
	update(event: SessionNotification): void;
	permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
}
export type AcpFactory = (handlers: AcpHandlers) => Promise<AcpPort>;

export interface AcpRuntime {
	beforeRequest?(
		method: string,
		cwd: string,
		request: AcpPort["request"],
		params: any,
	): Promise<void>;
	provider: string;
	error?(error: unknown, fallback: string): Error;
	discoveryCommand: string;
	command(
		activation: Activation,
		cwd: string,
	):
		| { executable: string; args: string[]; env?: NodeJS.ProcessEnv }
		| Promise<{ executable: string; args: string[]; env?: NodeJS.ProcessEnv }>;
	login(initialized: any, request: AcpPort["request"]): Promise<void>;
	models(session: NewSessionResponse): { id: string; name: string; configId: string }[];
}

export class AcpRuntimeError extends Error {}
export const GOOGLE_LOGIN_MESSAGE =
	"Antigravity is not logged in. Run agy and sign in, then retry discovery.";
export const GOOGLE_ACP_RUNTIME: AcpRuntime = {
	provider: ACP_PROVIDER,
	discoveryCommand: "poly-google-discover",
	command: (activation) => ({ executable: runtimePath(activation, "agy"), args: ["acp"] }),
	login: async (initialized) => {
		if (!initialized.authMethods?.some((method: { id: string }) => method.id === "oauth-personal"))
			throw new AcpRuntimeError(GOOGLE_LOGIN_MESSAGE);
		// Cached login belongs to agy. Never initiate an authentication flow from Pi.
	},
	beforeRequest: async () => assertEnvironment(ACP_PROVIDER),
	models: (session) => configModels(session).filter((model) => /^gemini[-.]/i.test(model.id)),
	error: (error, fallback) =>
		error instanceof AcpRuntimeError
			? error
			: new AcpRuntimeError(
					(error as { code?: number })?.code === -32000 ? GOOGLE_LOGIN_MESSAGE : fallback,
				),
};

export function officialAcpFactory(
	activation: Activation,
	cwd: string,
	runtime: AcpRuntime = GOOGLE_ACP_RUNTIME,
): AcpFactory {
	return async (handlers) => {
		if (!activation.enabled) throw new AcpRuntimeError("Runtime is off; enable it in poly.json");
		assertEnvironment(runtime.provider);
		const command = await runtime.command(activation, cwd);
		const child = spawn(command.executable, command.args, {
			cwd,
			env: command.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		// Runtime stderr can include authorization URLs and account data. Never relay it.
		child.stderr.resume();
		const app = client({ name: "pi-poly-agent" })
			.onNotification("session/update", ({ params }) => handlers.update(params))
			.onRequest("session/request_permission", ({ params }) => handlers.permission(params));
		const connection = app.connect(
			ndJsonStream(
				Writable.toWeb(child.stdin),
				Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
			),
		);
		child.once("error", () => connection.close(new Error("Official ACP runtime failed to start")));
		child.once("exit", () => connection.close());
		const close = () => {
			connection.close();
			child.kill("SIGTERM");
			const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
			timer.unref();
			child.once("exit", () => clearTimeout(timer));
		};
		try {
			const initialized = await connection.agent.request(
				"initialize",
				{
					protocolVersion: PROTOCOL_VERSION,
					clientInfo: { name: "pi-poly-agent", version: "0.6.0" },
					clientCapabilities: {},
				},
				{ cancellationSignal: AbortSignal.timeout(15000), stopWaitingOnCancel: true },
			);
			const request: AcpPort["request"] = (method, params, options) => {
				assertEnvironment(runtime.provider);
				return connection.agent.request(method, params, {
					cancellationSignal: options?.signal,
					stopWaitingOnCancel: true,
				});
			};
			await runtime.login(initialized, request);
			return {
				supportsLoad: initialized.agentCapabilities?.loadSession === true,
				request: async (method, params, options) => {
					await runtime.beforeRequest?.(method, cwd, request, params);
					return request(method, params, options);
				},
				notify: (m, p) => connection.agent.notify(m, p),
				close,
			};
		} catch (error) {
			close();
			const message = "Official ACP initialization failed; no alternate authentication attempted";
			throw runtime.error?.(error, message) || new Error(message);
		}
	};
}

export async function permissionDecision(
	request: RequestPermissionRequest,
	choose: (title: string, options: string[]) => Promise<string | undefined>,
	signal?: AbortSignal,
): Promise<RequestPermissionResponse> {
	if (signal?.aborted) return { outcome: { outcome: "cancelled" } };
	const description = permissionDescription(request);
	if (!description) return { outcome: { outcome: "cancelled" } };
	const options = request.options.filter(
		(option) => option.kind === "allow_once" || option.kind === "reject_once",
	);
	if (!options.length) return { outcome: { outcome: "cancelled" } };
	const labels = options.map((option, index) => `${index + 1}. ${JSON.stringify(option.name)}`);
	let selected: string | undefined;
	try {
		selected = await choose(description, labels);
	} catch {
		/* Deny on UI failure. */
	}
	const index = selected === undefined ? -1 : labels.indexOf(selected);
	if (signal?.aborted || index < 0) return { outcome: { outcome: "cancelled" } };
	return { outcome: { outcome: "selected", optionId: options[index].optionId } };
}

export function permissionDescription(request: RequestPermissionRequest): string | undefined {
	const call = request.toolCall;
	if (!call.title?.trim() || !call.kind) return;
	const input = call.rawInput && typeof call.rawInput === "object" ? call.rawInput : undefined;
	const details = { input, locations: call.locations, proposed: call.content };
	if (!Object.values(details).some((value) => value && Object.keys(value).length)) return;
	if (call.kind === "execute" && !hasCommand(input)) return;
	const text = JSON.stringify(details, null, 2);
	// Do not hide consequential arguments by truncating an approval preview.
	if (text.length > 16000) return;
	try {
		assertNoSecrets({ title: call.title, details, options: request.options });
	} catch {
		return;
	}
	const risk = ["execute", "edit", "delete", "move"].includes(call.kind)
		? "May execute commands or change files. Inspect arguments and proposed changes."
		: "Check target paths and access scope.";
	return `${JSON.stringify(call.title)} (${call.kind})\n${risk}\nPermission applies only to this invocation.\n${text}`;
}

function hasCommand(input: unknown): boolean {
	if (!input || typeof input !== "object") return false;
	return Object.entries(input).some(
		([key, value]) =>
			/command|cmd|args|argv|script/i.test(key) && !!value && JSON.stringify(value).length > 2,
	);
}

export function discoveredModels(
	session: NewSessionResponse,
	runtime: AcpRuntime = GOOGLE_ACP_RUNTIME,
): { id: string; name: string; configId: string }[] {
	return runtime.models(session);
}

export function configModels(
	session: NewSessionResponse,
): { id: string; name: string; configId: string }[] {
	const config = session.configOptions?.find(
		(option) => option.category === "model" || option.id === "model",
	);
	if (!config || config.type !== "select") return [];
	const options = config.options.flatMap((option) =>
		"group" in option ? option.options : [option],
	);
	return options.map((option) => ({ id: option.value, name: option.name, configId: config.id }));
}

/** One official session per Pi session in this process. No hidden cross-provider state transfer. */
export class AcpSession {
	private port?: AcpPort;
	private session?: NewSessionResponse;
	private active = false;
	private aborted?: AbortSignal;
	private update: (event: SessionNotification) => void = () => {};

	constructor(
		private factory: AcpFactory,
		private cwd: string,
		private choose: (title: string, options: string[]) => Promise<string | undefined>,
		private recovery?: {
			saved?: { sessionId: string; cwd: string };
			save(binding: { sessionId: string; cwd: string }): void;
			report(message: string): void;
		},
		private runtime: AcpRuntime = GOOGLE_ACP_RUNTIME,
	) {}

	async discover(fresh = false): Promise<ReturnType<typeof discoveredModels>> {
		await this.ensureSession(fresh);
		return discoveredModels(this.session!, this.runtime);
	}

	private async ensureSession(fresh: boolean): Promise<void> {
		if (this.session) return;
		try {
			this.port = await this.factory({
				update: (event) => this.receive(event),
				permission: (request) =>
					this.active && request.sessionId === this.session?.sessionId
						? permissionDecision(request, this.choose, this.aborted)
						: Promise.resolve({ outcome: { outcome: "cancelled" } }),
			});
			this.session = await this.openSession(fresh);
			if (!this.session?.modes?.availableModes.some((mode) => mode.id === "default"))
				throw new Error("Prompting mode unavailable");
			await this.port.request(
				"session/set_mode",
				{ sessionId: this.session.sessionId, modeId: "default" },
				{ signal: AbortSignal.timeout(15000) },
			);
			this.recovery?.save({ sessionId: this.session!.sessionId, cwd: this.cwd });
		} catch (error) {
			this.close();
			const message =
				"ACP session initialization failed. Check the executable, native login and default mode.";
			throw this.runtime.error?.(error, message) || new Error(message);
		}
	}

	private receive(event: SessionNotification): void {
		if (event.sessionId === this.session?.sessionId && this.active) this.update(event);
	}

	private async openSession(fresh: boolean): Promise<NewSessionResponse> {
		const saved = this.recovery?.saved;
		if (saved && !fresh) {
			if (saved.cwd !== this.cwd || !this.port!.supportsLoad) {
				this.recovery!.report(
					`Official runtime cannot restore this ACP session. Local history and /handoff remain available. Use /${this.runtime.discoveryCommand} new to authorize a fresh session.`,
				);
				throw new Error("ACP restoration unavailable");
			}
			try {
				const loaded = await this.port!.request(
					"session/load",
					{ sessionId: saved.sessionId, cwd: this.cwd, mcpServers: [] },
					{ signal: AbortSignal.timeout(15000) },
				);
				this.recovery!.report(
					"Official ACP session/load succeeded; local Pi history remains authoritative.",
				);
				return { ...loaded, sessionId: saved.sessionId };
			} catch (error) {
				this.recovery!.report(
					`ACP restoration failed. Saved binding and Pi history were preserved. Prepare /handoff and explicitly authorize /${this.runtime.discoveryCommand} new.`,
				);
				const message = "ACP restoration failed";
				throw this.runtime.error?.(error, message) || new Error(message);
			}
		}
		return this.port!.request(
			"session/new",
			{ cwd: this.cwd, mcpServers: [] },
			{ signal: AbortSignal.timeout(15000) },
		);
	}

	availableModes(): string[] {
		return (this.session?.modes?.availableModes || []).map((mode) => mode.id);
	}

	async selectMode(mode: string): Promise<void> {
		if (
			this.active ||
			!this.session ||
			!this.session.modes?.availableModes.some((entry) => entry.id === mode)
		)
			throw new Error("ACP permission mode is unavailable or forbidden");
		try {
			await this.port!.request(
				"session/set_mode",
				{ sessionId: this.session.sessionId, modeId: mode },
				{ signal: AbortSignal.timeout(15000) },
			);
		} catch (error) {
			const message = "ACP permission mode change failed";
			throw this.runtime.error?.(error, message) || new Error(message);
		}
	}

	async prompt(
		model: string,
		text: string,
		signal: AbortSignal | undefined,
		update: (event: SessionNotification) => void,
	): Promise<string> {
		if (this.active) throw new Error("ACP already has an active user turn");
		if (!this.session)
			throw new Error(
				`Run /${this.runtime.discoveryCommand} to authorize session initialization or recovery`,
			);
		const selected = discoveredModels(this.session!, this.runtime).find((m) => m.id === model);
		if (!selected) throw new Error("Model was not discovered from the official runtime");
		if (signal?.aborted) throw new Error("Cancelled");
		this.active = true;
		this.aborted = signal;
		this.update = update;
		const cancel = () => {
			void this.port
				?.notify("session/cancel", { sessionId: this.session!.sessionId })
				.catch(() => {});
		};
		signal?.addEventListener("abort", cancel, { once: true });
		try {
			await this.port!.request(
				"session/set_config_option",
				{ sessionId: this.session!.sessionId, configId: selected.configId, value: model },
				{ signal },
			);
			const result = await this.port!.request(
				"session/prompt",
				{ sessionId: this.session!.sessionId, prompt: [{ type: "text", text }] },
				{ signal },
			);
			return result.stopReason;
		} catch (error) {
			this.close();
			const message = "ACP turn failed or cancelled; no fallback attempted";
			throw this.runtime.error?.(error, message) || new Error(message);
		} finally {
			this.active = false;
			this.update = () => {};
			signal?.removeEventListener("abort", cancel);
		}
	}

	close(): void {
		this.port?.close();
		this.port = undefined;
		this.session = undefined;
	}
}
