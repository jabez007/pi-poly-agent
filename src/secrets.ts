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

/** Incremental screening keeps fixed patterns and unfinished variable-length forms across reads. */
export function secretScanner(): (chunk: string) => void {
	let carry = "";
	return (chunk) => {
		const text = (carry + chunk).replace(/\s+/g, " ");
		assertNoSecrets(text);
		const privateLabel = /-----BEGIN [\w ]*$/i.exec(text)?.[0];
		const url = /https?:\/\/[^\s/]*$/i.exec(text)?.[0];
		if (privateLabel && privateLabel.length > 256) carry = "-----BEGIN " + privateLabel.slice(-128);
		else if (url && url.length > 256) {
			const userinfo = url.slice(url.indexOf("://") + 3);
			carry = (userinfo.indexOf(":") > 0 ? "https://u:" : "https://") + userinfo.slice(-128);
		} else carry = text.slice(-256);
	};
}
