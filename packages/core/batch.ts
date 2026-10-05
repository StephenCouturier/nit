import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ReplyVia } from "./render.ts"
import { dispatchOrder } from "./render.ts"
import { batchDir, writeJsonAtomic } from "./store.ts"
import type { ReviewState, Thread, ThreadStatus } from "./threads.ts"

/**
 * One press of `F`: the threads that were sent to an agent, how they were sent,
 * and what came back. Batches are append-only history; the live thread state
 * stays in the branch state file.
 */
export interface ReviewBatch {
	version: 1
	id: string
	repo: string
	branch: string
	baseRef: string
	/** Dispatch order; the agent's section N maps to threadIds[N - 1]. */
	threadIds: string[]
	/** Threads as they were when sent. */
	snapshot: Thread[]
	transport: string
	replyVia: ReplyVia
	/** The exact markdown handed to the agent. */
	prompt: string
	head?: string
	status: "pending" | "settled"
	createdAt: number
	settledAt?: number
	results: BatchResult[]
}

export interface BatchResult {
	threadId: string
	status: ThreadStatus
	reply?: string
	source: "tool" | "cli" | "sections" | "settle"
	ts: number
}

function newBatchId(): string {
	return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function createBatch(
	state: ReviewState,
	threads: Thread[],
	options: { transport: string; replyVia: ReplyVia; prompt: string; head?: string },
): ReviewBatch {
	const ordered = dispatchOrder(threads)
	return {
		version: 1,
		id: newBatchId(),
		repo: state.repo,
		branch: state.branch,
		baseRef: state.baseRef,
		threadIds: ordered.map((thread) => thread.id),
		snapshot: structuredClone(ordered),
		transport: options.transport,
		replyVia: options.replyVia,
		prompt: options.prompt,
		head: options.head,
		status: "pending",
		createdAt: Date.now(),
		results: [],
	}
}

export function batchFile(batch: Pick<ReviewBatch, "repo" | "branch" | "id">): string {
	return join(batchDir(batch.repo, batch.branch), `${batch.id}.json`)
}

export async function saveBatch(batch: ReviewBatch): Promise<void> {
	await writeJsonAtomic(batchFile(batch), batch)
}

export async function loadBatch(repo: string, branch: string, id: string): Promise<ReviewBatch | null> {
	try {
		return JSON.parse(await readFile(batchFile({ repo, branch, id }), "utf-8")) as ReviewBatch
	} catch {
		return null
	}
}

/** Newest first. */
export async function listBatches(repo: string, branch: string): Promise<ReviewBatch[]> {
	let names: string[]
	try {
		names = await readdir(batchDir(repo, branch))
	} catch {
		return []
	}
	const batches: ReviewBatch[] = []
	for (const name of names) {
		if (!name.endsWith(".json")) continue
		const batch = await loadBatch(repo, branch, name.slice(0, -".json".length))
		if (batch) batches.push(batch)
	}
	return batches.sort((a, b) => b.createdAt - a.createdAt)
}

export function recordResult(batch: ReviewBatch, result: Omit<BatchResult, "ts">): void {
	batch.results.push({ ...result, ts: Date.now() })
	const answered = new Set(batch.results.map((entry) => entry.threadId))
	if (batch.threadIds.every((id) => answered.has(id))) {
		batch.status = "settled"
		batch.settledAt ??= Date.now()
	}
}

export function findBatchForThread(batches: ReviewBatch[], threadId: string): ReviewBatch | undefined {
	return batches.find((batch) => batch.status === "pending" && batch.threadIds.includes(threadId))
}
