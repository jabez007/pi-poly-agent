/** Bound host waits even if a transport ignores cancellation. Adapters still own abort/disposal. */
export async function untilCanceled<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw new Error("Canceled");
	let cancel: () => void = () => {};
	const aborted = new Promise<never>((_resolve, reject) => {
		cancel = () => reject(new Error("Canceled"));
		signal.addEventListener("abort", cancel, { once: true });
	});
	try {
		return await Promise.race([operation, aborted]);
	} finally {
		signal.removeEventListener("abort", cancel);
	}
}
