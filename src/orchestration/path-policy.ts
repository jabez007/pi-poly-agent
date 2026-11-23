/** Metadata checks must agree even when the filesystem folds filename case. */
export function gitMetadataName(name: string): boolean {
	return /^\.git(\.|$)/i.test(name);
}
