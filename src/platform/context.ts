import {
	assertNoSecrets,
	ProjectMemory,
	connectMemPalace,
	type MemoryTransport,
} from "../memory.ts";
export interface ContextQuery {
	project: string;
	objective: string;
	budget: number;
}
export interface ContextRecord {
	text: string;
	source: string;
	project: string;
	certainty: "verified" | "claim";
}
export interface ContextBackend {
	id: string;
	retrieve(query: ContextQuery): Promise<ContextRecord[]>;
	checkpoint?(query: ContextQuery, records: ContextRecord[]): Promise<void>;
	close?(): Promise<void>;
}
/** Backend failures cannot prevent independent execution; all records retain attribution. */
export class ContextRegistry {
	private backends = new Map<string, ContextBackend>();
	constructor(private timeoutMs = 8000) {
		if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000)
			throw new Error("Invalid context timeout");
	}
	register(backend: ContextBackend): void {
		if (this.backends.has(backend.id))
			throw new Error("Context backend identifier already registered");
		this.backends.set(backend.id, backend);
	}
	async retrieve(
		ids: string[],
		query: ContextQuery,
	): Promise<{ text: string; unavailable: string[] }> {
		const selected: string[] = [],
			unavailable: string[] = [],
			seen = new Set<string>();
		for (const id of ids) {
			const backend = this.backends.get(id);
			try {
				if (!backend) throw new Error("Backend unavailable");
				for (const record of await bounded(backend.retrieve(query), this.timeoutMs))
					this.select(record, query, selected, seen);
			} catch {
				unavailable.push(id);
			}
		}
		return { text: selected.join("\n\n"), unavailable };
	}
	private select(
		record: ContextRecord,
		query: ContextQuery,
		selected: string[],
		seen: Set<string>,
	): void {
		assertNoSecrets(record);
		if (
			!record.text?.trim() ||
			record.project !== query.project ||
			!record.source ||
			!["verified", "claim"].includes(record.certainty)
		)
			return;
		const identity = record.text.trim().toLowerCase().replace(/\s+/g, " ");
		const text = `${record.certainty}: ${record.text}\nSource: ${record.source}`;
		if (seen.has(identity) || selected.join("\n\n").length + text.length + 2 > query.budget) return;
		selected.push(text);
		seen.add(identity);
	}
	async checkpoint(id: string, query: ContextQuery, records: ContextRecord[]): Promise<void> {
		assertNoSecrets(records);
		if (records.some((r) => r.project !== query.project))
			throw new Error("Cross-project checkpoint refused");
		const backend = this.backends.get(id);
		if (!backend?.checkpoint) throw new Error("Context backend does not support checkpoints");
		await backend.checkpoint(query, records);
	}
	async close(): Promise<void> {
		await Promise.all([...this.backends.values()].map((b) => b.close?.()));
	}
}
export function nativeContext(
	read: (query: ContextQuery) => string | Promise<string>,
): ContextBackend {
	return {
		id: "native",
		retrieve: async (query) => [
			{
				text: await read(query),
				source: "Pi reviewed handoff and local task artifacts",
				project: query.project,
				certainty: "claim",
			},
		],
	};
}
export function memPalaceContext(
	shared: string[] = [],
	connect = connectMemPalace,
): ContextBackend {
	let transport: MemoryTransport | undefined;
	return {
		id: "mempalace",
		retrieve: async (query) => {
			transport ??= await connect();
			const text = await new ProjectMemory(transport, query.project, shared, query.budget).recall(
				query.objective,
			);
			return text
				? [
						{
							text,
							source: `MemPalace project ${query.project}; individual sources inline`,
							project: query.project,
							certainty: "claim",
						},
					]
				: [];
		},
		close: async () => {
			await transport?.close();
		},
	};
}

async function bounded<T>(operation: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("Context backend timed out")), ms);
			}),
		]);
	} finally {
		clearTimeout(timer!);
	}
}
