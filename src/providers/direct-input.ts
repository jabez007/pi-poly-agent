import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BRIDGE_PROVIDER, directOnlyProvider } from "../policy.ts";

/** Pi supplies the input source. A runtime turn must originate in the interactive editor. */
export function directPrompts(pi: ExtensionAPI) {
	let pending: { provider: string; text: string } | undefined;
	const clear = () => {
		pending = undefined;
	};
	pi.on("input", (event, context) => {
		clear();
		const provider = context.model?.provider || "";
		if (!directOnlyProvider(provider)) return { action: "continue" };
		if (event.source !== "interactive" || !context.hasUI || context.mode !== "tui") {
			context.ui.notify("This runtime accepts direct interactive user input only.", "error");
			return { action: "handled" };
		}
		if (event.streamingBehavior) {
			context.ui.notify(
				"Wait for or cancel the current runtime turn before submitting another prompt.",
				"warning",
			);
			return { action: "handled" };
		}
		if (provider !== BRIDGE_PROVIDER && (event.images?.length || event.text.startsWith("!"))) {
			context.ui.notify(
				"ACP accepts direct text prompts. Images and shell commands are not forwarded.",
				"warning",
			);
			return { action: "handled" };
		}
		pending = { provider, text: event.text };
		return { action: "continue" };
	});
	pi.on("agent_settled", clear);
	pi.on("model_select", clear);
	pi.on("session_start", clear);
	pi.on("session_shutdown", clear);
	const require = (provider: string): string => {
		if (pending?.provider !== provider)
			throw new Error("This runtime requires a direct interactive user prompt");
		return pending.text;
	};
	return {
		require,
		consume(provider: string): string {
			const text = require(provider);
			clear();
			return text;
		},
	};
}
