import type { ReviewBatch } from "./batch.ts"
import { createBatch, findBatchForThread, listBatches, loadBatch, recordResult, saveBatch } from "./batch.ts"
import { loadConfig, loadTemplates } from "./config.ts"
import type { FileDiff } from "./diff.ts"
import { parseUnifiedDiff } from "./diff.ts"
import type { Exec, RepoBasics, ReviewScope } from "./git.ts"
import { getFileDiff, getRepoBasics, getRepoInfo, listChangedFiles } from "./git.ts"
import type { DispatchPrompt, ReplyVia } from "./render.ts"
import { buildDispatchPrompt, parseAgentSections } from "./render.ts"
import { legacyStatePath, loadState, reanchorThreads, saveState, statePath } from "./store.ts"
import type { ReplyStatus, ReviewState, Thread } from "./threads.ts"
import { applyAgentReply, dispatchStatus, isInFlight, setStatus } from "./threads.ts"

/** Host-specific knobs. `legacyAgentDir` lets the pi host pick up reviews saved before the standalone store. */
export interface HostOptions {
	legacyAgentDir?: string
}

export interface LoadedReview {
	state: ReviewState
	files: FileDiff[]
	file: string
}

function stateFiles(repo: RepoBasics, host: HostOptions): { file: string; legacy?: string } {
	return {
		file: statePath(repo.root, repo.branch),
		legacy: host.legacyAgentDir ? legacyStatePath(host.legacyAgentDir, repo.root, repo.branch) : undefined,
	}
}

export async function loadReview(
	exec: Exec,
	args: { scope: ReviewScope; baseOverride?: string },
	host: HostOptions = {},
): Promise<LoadedReview> {
	const repo = await getRepoInfo(exec, args)
	const changed = await listChangedFiles(exec, repo.diffBase)

	const files: FileDiff[] = []
	for (const entry of changed) {
		const raw = await getFileDiff(exec, repo.diffBase, entry)
		files.push(parseUnifiedDiff(raw, entry.path, entry.oldPath))
	}

	const label = repo.scope === "local" ? "HEAD (local changes)" : repo.baseRef
	const { file, legacy } = stateFiles(repo, host)
	const state = await loadState(file, repo.root, repo.branch, label, legacy)
	state.repo = repo.root
	state.branch = repo.branch

	reanchorThreads(state, new Map(files.map((entry) => [entry.path, entry])))
	await saveState(file, state)

	return { state, files, file }
}

/** Current branch state without computing the diff (for CLI/MCP replies). */
export async function loadBranchState(
	exec: Exec,
	host: HostOptions = {},
): Promise<{ repo: RepoBasics; state: ReviewState; file: string }> {
	const repo = await getRepoBasics(exec)
	const { file, legacy } = stateFiles(repo, host)
	const state = await loadState(file, repo.root, repo.branch, undefined, legacy)
	return { repo, state, file }
}

export interface Dispatched {
	batch: ReviewBatch
	prompt: DispatchPrompt
}

/** Mark threads in flight, record a batch, and render the prompt. Delivery is the transport's job. */
export async function dispatchThreads(
	exec: Exec,
	loaded: { state: ReviewState; file: string; files?: FileDiff[] },
	threads: Thread[],
	options: { transport: string; replyVia: ReplyVia; deleted?: Iterable<string> },
): Promise<Dispatched> {
	for (const thread of threads) setStatus(thread, dispatchStatus(thread))
	await saveState(loaded.file, loaded.state, options.deleted)

	const config = loadConfig()
	const prompt = buildDispatchPrompt(threads, loaded.state.baseRef, {
		replyVia: options.replyVia,
		templates: loadTemplates(),
		context: config.context,
		branch: loaded.state.branch,
		files: loaded.files ? new Map(loaded.files.map((file) => [file.path, file])) : undefined,
	})
	const head = await exec("git", ["rev-parse", "HEAD"])
	const batch = createBatch(loaded.state, threads, {
		transport: options.transport,
		replyVia: options.replyVia,
		prompt: prompt.text,
		head: head.code === 0 ? head.stdout.trim() : undefined,
	})
	await saveBatch(batch)
	return { batch, prompt }
}

/** Structured per-thread reply from an agent (MCP tool or CLI). */
export async function replyToThreadById(
	exec: Exec,
	threadId: string,
	text: string,
	options: { status?: ReplyStatus; source: "tool" | "cli"; host?: HostOptions },
): Promise<Thread> {
	const { repo, state, file } = await loadBranchState(exec, options.host)
	const thread = state.threads.find((entry) => entry.id === threadId)
	if (!thread) throw new Error(`no thread ${threadId} on ${repo.branch}`)

	applyAgentReply(thread, text, options.status)
	await saveState(file, state)

	const batch = findBatchForThread(await listBatches(repo.root, repo.branch), threadId)
	if (batch) {
		recordResult(batch, { threadId, status: thread.status, reply: text, source: options.source })
		await saveBatch(batch)
	}
	return thread
}

/**
 * The agent finished its turn. Threads that already got a structured reply are left alone.
 * The rest are filled from the final message's numbered sections; if there is nothing to
 * route, they are flagged `needs_review` rather than silently resolved.
 */
export async function settleBatch(
	exec: Exec,
	batchId: string,
	finalText: string | undefined,
	host: HostOptions = {},
): Promise<{ batch: ReviewBatch; routed: number; unanswered: number } | null> {
	const { repo, state, file } = await loadBranchState(exec, host)
	const batch = await loadBatch(repo.root, repo.branch, batchId)
	if (!batch) return null

	const sections = finalText ? parseAgentSections(finalText) : new Map<number, string>()
	const replied = new Set(batch.results.map((result) => result.threadId))
	let routed = 0
	let unanswered = 0

	batch.threadIds.forEach((id, index) => {
		if (replied.has(id)) return
		const thread = state.threads.find((entry) => entry.id === id)
		if (!thread || !isInFlight(thread)) return

		// With no sections at all, a lone free-form answer to a single-thread batch is still unambiguous.
		const reply = sections.get(index + 1) ?? (sections.size === 0 && batch.threadIds.length === 1 ? finalText : undefined)
		if (reply) {
			applyAgentReply(thread, reply)
			recordResult(batch, { threadId: id, status: thread.status, reply, source: "sections" })
			routed++
		} else {
			setStatus(thread, "needs_review")
			recordResult(batch, { threadId: id, status: thread.status, source: "settle" })
			unanswered++
		}
	})

	batch.status = "settled"
	batch.settledAt ??= Date.now()
	await saveState(file, state)
	await saveBatch(batch)
	return { batch, routed, unanswered }
}

export async function pendingThreads(exec: Exec, host: HostOptions = {}): Promise<{ batches: ReviewBatch[]; threads: Thread[] }> {
	const { repo, state } = await loadBranchState(exec, host)
	const batches = (await listBatches(repo.root, repo.branch)).filter((batch) => batch.status === "pending")
	const ids = new Set(batches.flatMap((batch) => batch.threadIds))
	return { batches, threads: state.threads.filter((thread) => ids.has(thread.id) && isInFlight(thread)) }
}
