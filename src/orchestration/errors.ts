export type FailureCode =
	| "authentication"
	| "unavailable"
	| "model"
	| "quota"
	| "transport"
	| "context"
	| "tool"
	| "policy"
	| "budget"
	| "output"
	| "unknown";
const MESSAGES: Record<FailureCode, string> = {
	budget:
		"Worker request budget exhausted. Inspect preserved results before explicitly starting replacement work. No continuation was sent.",
	authentication:
		"Authentication unavailable or rejected. Use the supported /login path, then explicitly replace the task.",
	unavailable: "Provider unavailable. Check provider status before explicitly replacing the task.",
	model:
		"Requested model unavailable. Select an available model explicitly; no fallback was selected.",
	quota:
		"Provider rate limit or quota reached. Wait for your plan to permit usage; no retry or credential rotation was attempted.",
	transport:
		"Transport interrupted. Inspect preserved changes before explicitly replacing the task; the generation was not replayed.",
	context:
		"Context window exhausted. Review a smaller focused brief before launching a replacement.",
	tool: "Worker tool or worktree operation failed. Inspect the preserved worktree and prerequisites.",
	policy:
		"Worker policy refused execution. Review capabilities and configuration; no fallback was attempted.",
	output:
		"Worker returned invalid or sensitive output. Output was withheld; inspect preserved source changes.",
	unknown:
		"Worker failed. Inspect preserved results and worktree before explicitly replacing it. No fallback or replay was attempted.",
};
export class WorkerFailure extends Error {
	constructor(readonly code: FailureCode) {
		super(`[${code}] ${MESSAGES[code]}`);
	}
}
/** Only locally calculated numeric metadata is eligible for detailed budget diagnostics. */
export class ReviewBudgetError extends WorkerFailure {
	constructor(
		readonly required: number,
		readonly budget: number,
		readonly scope: "view" | "packet" = "view",
	) {
		super("context");
		if (
			!Number.isSafeInteger(required) ||
			!Number.isSafeInteger(budget) ||
			required < 0 ||
			budget < 0
		)
			throw new Error("Invalid review budget metadata");
		this.message =
			scope === "packet"
				? `Review packet requires at least ${required} characters for its required view; configured context budget is ${budget}. View allocation is capped at 6000 after context reserves. Increase a smaller budget, shorten paths or inspect manually.`
				: `Review view needs ${required} characters of metadata; budget is ${budget}. Increase a smaller budget, shorten paths or inspect the task manually.`;
	}
}
/** Classify locally, then discard the raw provider body. Never persist or display it. */
export function classifyFailure(error: unknown): FailureCode {
	if (error instanceof WorkerFailure) return error.code;
	const raw = error as any;
	const text = errorText(raw);
	const marker = /^\[([a-z]+)\]/.exec(text);
	if (marker && marker[1] in MESSAGES) return marker[1] as FailureCode;
	const status = errorStatus(raw);
	const codes: Record<number, FailureCode> = {
		401: "authentication",
		403: "authentication",
		429: "quota",
	};
	if (codes[status]) return codes[status];
	if (status >= 500) return "unavailable";
	const lower = text.toLowerCase();
	const rules: [FailureCode, RegExp][] = [
		["authentication", /auth|unauthorized|login|credential/],
		["quota", /rate.?limit|quota|too many requests/],
		["context", /context.{0,30}(window|length|limit)|too many tokens/],
		["model", /model.{0,30}(not found|unavailable|unsupported)|requested worker model/],
		["unavailable", /unavailable|overloaded/],
		["transport", /transport|socket|econn|network|fetch failed|connection/],
		["tool", /tool|git operation|worktree|sandbox/],
		["policy", /policy|authorized|delegation|fallback|override|environment/],
		["output", /sensitive|secret|structured|json|budget/],
	];
	for (const [code, pattern] of rules) if (pattern.test(lower)) return code;
	return "unknown";
}
export function safeFailure(error: unknown): WorkerFailure {
	if (error instanceof ReviewBudgetError)
		return new ReviewBudgetError(error.required, error.budget, error.scope);
	return new WorkerFailure(classifyFailure(error));
}

function errorText(value: any): string {
	return String(value?.message ?? value ?? "");
}
function errorStatus(value: any): number {
	return value?.status ?? value?.statusCode;
}
