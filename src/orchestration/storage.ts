import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { assertSafeProfile } from "../profile.ts";

/** Rename publishes a complete record; fsync protects it across process and system interruption. */
export function atomicRecord(path: string, value: unknown): void {
	assertSafeProfile(path);
	const temporary = `${path}.${randomUUID()}.tmp`;
	const fd = openSync(temporary, "wx", 0o600);
	try {
		writeFileSync(fd, JSON.stringify(value, null, 2));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, path);
	const directory = openSync(dirname(path), "r");
	try {
		fsyncSync(directory);
	} finally {
		closeSync(directory);
	}
}
function processStart(pid: number): string {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
	} catch {
		return "unknown";
	}
}
function liveOwner(owner: { pid: number; start: string; host: string }): boolean {
	if (owner.host !== hostname())
		throw new Error("Task host belongs to another machine; inspect the lease manually");
	try {
		process.kill(owner.pid, 0);
	} catch (error: any) {
		if (error.code === "ESRCH") return false;
		return true;
	}
	const start = processStart(owner.pid);
	return start === "unknown" || owner.start === "unknown" || start === owner.start;
}

/** A short acquisition guard prevents two restart processes from both reclaiming a stale lease. */
export function acquireHost(directory: string): () => void {
	const lock = join(directory, "host.json");
	const guard = join(directory, "host-acquisition");
	assertSafeProfile(lock);
	assertSafeProfile(guard);
	try {
		mkdirSync(guard, { mode: 0o700 });
	} catch {
		throw new Error(
			"Task host acquisition is busy or interrupted; inspect host-acquisition before removing it",
		);
	}
	const owner = {
		pid: process.pid,
		start: processStart(process.pid),
		host: hostname(),
		token: randomUUID(),
	};
	try {
		if (existsSync(lock)) {
			const previous = readOwner(lock);
			if (!Number.isInteger(previous.pid) || previous.pid < 1 || !previous.start || !previous.host)
				throw new Error("Invalid task host lease; inspect host.json manually");
			if (liveOwner(previous))
				throw new Error("Another Pi task host owns this project; close it before continuing");
		}
		atomicRecord(lock, owner);
	} finally {
		rmSync(guard, { recursive: true });
	}
	return () => {
		if (!existsSync(lock)) return;
		if (readOwner(lock).token === owner.token) rmSync(lock);
	};
}

function readOwner(path: string): any {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error("Task host lease unreadable; inspect host.json locally. Values withheld.");
	}
}
