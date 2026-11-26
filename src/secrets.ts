// Known secret forms are rejected, including secrets carried in source references.
// Arbitrary personal or confidential text still requires the user's preview.
export function assertNoSecrets(value: unknown): void {
	const text = JSON.stringify(value).replace(/\\(["'])/g, "$1");
	if (
		/(?:sk-ant-|sk-proj-|AIza[\w-]{20}|-----BEGIN [\w ]*PRIVATE KEY|Bearer\s+\S+|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)\s*["']?\s*[:=]\s*["']?\S+|https?:\/\/[^\s/]+:[^\s/]+@)/i.test(
			text,
		)
	) {
		throw new Error("Sensitive content detected; checkpoint refused");
	}
}
