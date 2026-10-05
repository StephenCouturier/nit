import { cpSync, existsSync } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { FileDiff } from "./diff.ts"
import { findLineText } from "./diff.ts"
import type { ReviewState, Thread } from "./threads.ts"
import { createState, migrateThread } from "./threads.ts"

function slugify(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed"
}

/**
 * nit was called llm-review; the first time a nit directory is needed, copy the old one
 * across (copy, not move, so the legacy tool keeps working) and use the copy from then on.
 */
export function adoptLegacyDir(dir: string, legacy: string): string {
	if (!existsSync(dir) && existsSync(legacy)) {
		try {
			cpSync(legacy, dir, { recursive: true })
		} catch {
			// Unreadable legacy data just means starting fresh.
		}
	}
	return dir
}

export function dataDir(): string {
	if (process.env.NIT_HOME) return process.env.NIT_HOME
	const xdg = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
	return adoptLegacyDir(join(xdg, "nit"), join(xdg, "llm-review"))
}

export function statePath(repoRoot: string, branch: string, baseDir = dataDir()): string {
	return join(baseDir, slugify(repoRoot), `${slugify(branch)}.json`)
}

export function batchDir(repoRoot: string, branch: string, baseDir = dataDir()): string {
	return join(baseDir, slugify(repoRoot), slugify(branch), "batches")
}

/** Pre-standalone location, read once as a fallback so existing reviews carry over. */
export function legacyStatePath(agentDir: string, repoRoot: string, branch: string): string {
	return statePath(repoRoot, branch, join(agentDir, "llm-review"))
}

async function readJson<T>(file: string): Promise<T | null> {
	try {
		return JSON.parse(await readFile(file, "utf-8")) as T
	} catch {
		return null
	}
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
	await mkdir(dirname(file), { recursive: true })
	const tmp = `${file}.${process.pid}.tmp`
	await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8")
	await rename(tmp, file)
}

export async function loadState(
	file: string,
	repoRoot: string,
	branch: string,
	baseRef?: string,
	legacyFile?: string,
): Promise<ReviewState> {
	let parsed = await readJson<ReviewState>(file)
	if (!parsed && legacyFile) parsed = await readJson<ReviewState>(legacyFile)
	if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.threads)) {
		return createState(repoRoot, branch, baseRef ?? "HEAD")
	}
	if (baseRef) parsed.baseRef = baseRef
	parsed.threads.forEach(migrateThread)
	return parsed
}

async function readThreadsOnDisk(file: string): Promise<Thread[]> {
	const parsed = await readJson<ReviewState>(file)
	return parsed && Array.isArray(parsed.threads) ? parsed.threads.map(migrateThread) : []
}

export async function saveState(
	file: string,
	state: ReviewState,
	deletedIds: Iterable<string> = [],
): Promise<void> {
	const deleted = new Set(deletedIds)
	const onDisk = await readThreadsOnDisk(file)
	const merged = new Map<string, Thread>()

	for (const thread of onDisk) {
		if (deleted.has(thread.id)) continue
		merged.set(thread.id, thread)
	}
	for (const thread of state.threads) {
		if (deleted.has(thread.id)) continue
		// Another writer (MCP server, CLI, a second session) may have replied since we loaded.
		const disk = merged.get(thread.id)
		if (disk && disk.updatedAt > thread.updatedAt) continue
		merged.set(thread.id, thread)
	}

	const threads = [...merged.values()].sort((a, b) => a.createdAt - b.createdAt)
	state.threads = threads

	await writeJsonAtomic(file, { ...state, threads })
}

function reanchorThread(thread: Thread, file: FileDiff | undefined): void {
	if (!file) {
		if (thread.status !== "resolved") thread.status = "orphaned"
		return
	}

	const atSameLine = findLineText(file, thread.line, thread.side)
	if (atSameLine !== undefined && atSameLine === thread.anchorText) {
		if (thread.status === "orphaned") thread.status = "open"
		return
	}

	const candidates: number[] = []
	for (const hunk of file.hunks) {
		for (const line of hunk.lines) {
			const no = thread.side === "new" ? line.newNo : line.oldNo
			if (no !== null && line.text === thread.anchorText) candidates.push(no)
		}
	}

	if (candidates.length === 0) {
		if (thread.status !== "resolved") thread.status = "orphaned"
		return
	}

	let best = candidates[0]!
	for (const candidate of candidates) {
		if (Math.abs(candidate - thread.line) < Math.abs(best - thread.line)) best = candidate
	}
	if (thread.endLine !== undefined) thread.endLine += best - thread.line
	thread.line = best
	if (thread.status === "orphaned") thread.status = "open"
}

export function reanchorThreads(state: ReviewState, files: Map<string, FileDiff>): void {
	for (const thread of state.threads) {
		reanchorThread(thread, files.get(thread.path))
	}
}
