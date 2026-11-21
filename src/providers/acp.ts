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
import { attestRuntime } from "../profile.ts";
import { assertEnvironment } from "../policy.ts";

export interface AcpPort {
	request(method: string, params: any, options?: { signal?: AbortSignal }): Promise<any>;
	notify(method: string, params: any): Promise<void>;
	close(): void;
}
export interface AcpHandlers {
	update(event: SessionNotification): void;
	permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
}
export type AcpFactory = (handlers: AcpHandlers) => Promise<AcpPort>;

export function officialAcpFactory(activation: Activation, cwd: string): AcpFactory {
	return async (handlers) => {
		assertEnvironment(process.env);
		const executable = attestRuntime(activation);
		const child = spawn(executable, ["acp"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
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
		};
		try {
			const initialized = await connection.agent.request(
				"initialize",
				{
					protocolVersion: PROTOCOL_VERSION,
					clientInfo: { name: "pi-poly-agent", version: "0.1.0" },
					clientCapabilities: {},
				},
				{ cancellationSignal: AbortSignal.timeout(15000), stopWaitingOnCancel: true },
			);
			if (!initialized.authMethods?.some((method) => method.id === "oauth-personal")) {
				throw new Error("Runtime does not advertise native personal OAuth");
			}
			// Documented ACP request. Credentials and browser flow stay inside Google's runtime.
			await connection.agent.request(
				"authenticate",
				{ methodId: "oauth-personal" },
				{ cancellationSignal: AbortSignal.timeout(120000), stopWaitingOnCancel: true },
			);
			return {
				request: (m, p, o) =>
					connection.agent.request(m, p, {
						cancellationSignal: o?.signal,
						stopWaitingOnCancel: true,
					}),
				notify: (m, p) => connection.agent.notify(m, p),
				close,
			};
		} catch {
			close();
			throw new Error("Official ACP initialization failed; no alternate authentication attempted");
		}
	};
}

export async function permissionDecision(
	request: RequestPermissionRequest,
	choose: (title: string, options: string[]) => Promise<string | undefined>,
	signal?: AbortSignal,
): Promise<RequestPermissionResponse> {
	if (signal?.aborted) return { outcome: { outcome: "cancelled" } };
	const options = request.options.filter(
		(option) => option.kind === "allow_once" || option.kind === "reject_once",
	);
	const labels = options.map((option, index) => `${index + 1}. ${option.name}`);
	let selected: string | undefined;
	try {
		selected = await choose(request.toolCall.title || "ACP tool permission", labels);
	} catch {
		/* Deny on UI failure. */
	}
	const index = selected === undefined ? -1 : labels.indexOf(selected);
	if (signal?.aborted || index < 0) return { outcome: { outcome: "cancelled" } };
	return { outcome: { outcome: "selected", optionId: options[index].optionId } };
}

export function discoveredModels(
	session: NewSessionResponse,
): { id: string; name: string; configId: string }[] {
	const config = session.configOptions?.find(
		(option) => option.category === "model" || option.id === "model",
	);
	if (!config || config.type !== "select") return [];
	const options = config.options.flatMap((option) =>
		"group" in option ? option.options : [option],
	);
	// Google consumer ACP access in this profile is restricted to Gemini models.
	return options
		.filter((option) => /^gemini[-.]/i.test(option.value))
		.map((option) => ({ id: option.value, name: option.name, configId: config.id }));
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
	) {}

	async discover(): Promise<ReturnType<typeof discoveredModels>> {
		await this.ensureSession();
		return discoveredModels(this.session!);
	}

	private async ensureSession(): Promise<void> {
		if (this.session) return;
		try {
			this.port = await this.factory({
				update: (event) => {
					if (this.active && event.sessionId === this.session?.sessionId) this.update(event);
				},
				permission: (request) =>
					this.active && request.sessionId === this.session?.sessionId
						? permissionDecision(request, this.choose, this.aborted)
						: Promise.resolve({ outcome: { outcome: "cancelled" } }),
			});
			this.session = await this.port.request(
				"session/new",
				{ cwd: this.cwd, mcpServers: [] },
				{ signal: AbortSignal.timeout(15000) },
			);
			if (!this.session?.modes?.availableModes.some((mode) => mode.id === "default"))
				throw new Error("Prompting mode unavailable");
			await this.port.request(
				"session/set_mode",
				{ sessionId: this.session.sessionId, modeId: "default" },
				{ signal: AbortSignal.timeout(15000) },
			);
		} catch {
			this.close();
			throw new Error("ACP session initialization failed; prompting mode is required");
		}
	}

	async prompt(
		model: string,
		text: string,
		signal: AbortSignal | undefined,
		update: (event: SessionNotification) => void,
	): Promise<string> {
		if (this.active) throw new Error("ACP already has an active user turn");
		await this.ensureSession();
		const selected = discoveredModels(this.session!).find((m) => m.id === model);
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
		} catch {
			this.close();
			throw new Error("ACP turn failed or cancelled; no fallback attempted");
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
