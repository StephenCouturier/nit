/** A comment either asks for a change or asks a question. */
export type ThreadKind = "fix" | "question"

/** Pre-0.3 severities; only read when migrating old state files. */
type LegacySeverity = "critical" | "warning" | "suggestion" | "question"

export type ThreadStatus =
	| "open"
	| "fixing"
	| "resolved"
	| "orphaned"
	| "asking"
	| "answered"
	| "wontfix"
	| "needs_info"
	| "needs_review"

/** Statuses an agent may set when replying to a thread. */
export const REPLY_STATUSES = ["resolved", "answered", "wontfix", "needs_info"] as const
export type ReplyStatus = (typeof REPLY_STATUSES)[number]

export interface ThreadMessage {
	role: "user" | "agent"
	text: string
	ts: number
}

export interface Thread {
	id: string
	path: string
	line: number
	/** Last line of a range comment; absent for single-line comments. */
	endLine?: number
	side: "new" | "old"
	anchorText: string
	kind: ThreadKind
	/** @deprecated legacy field from state files written before comment types replaced severities */
	severity?: LegacySeverity
	status: ThreadStatus
	messages: ThreadMessage[]
	createdAt: number
	updatedAt: number
}

export interface ReviewState {
	version: 1
	repo: string
	branch: string
	baseRef: string
	threads: Thread[]
	/** Files marked viewed, keyed by path, with the diff hash they were viewed at. */
	viewed?: Record<string, string>
}

export const KIND_LABEL: Record<ThreadKind, string> = {
	fix: "FIX",
	question: "QUESTION",
}

export function isQuestion(thread: Thread): boolean {
	return thread.kind === "question"
}

/** Bring threads from older state files up to the current shape. */
export function migrateThread(thread: Thread): Thread {
	if (thread.kind !== "fix" && thread.kind !== "question") {
		thread.kind = thread.severity === "question" ? "question" : "fix"
	}
	delete thread.severity
	return thread
}

export function createState(repo: string, branch: string, baseRef: string): ReviewState {
	return { version: 1, repo, branch, baseRef, threads: [] }
}

function newId(): string {
	return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function addThread(
	state: ReviewState,
	input: {
		path: string
		line: number
		endLine?: number
		side: "new" | "old"
		anchorText: string
		kind: ThreadKind
		text: string
	},
): Thread {
	const now = Date.now()
	const thread: Thread = {
		id: newId(),
		path: input.path,
		line: input.line,
		...(input.endLine !== undefined && input.endLine > input.line ? { endLine: input.endLine } : {}),
		side: input.side,
		anchorText: input.anchorText,
		kind: input.kind,
		status: "open",
		messages: [{ role: "user", text: input.text, ts: now }],
		createdAt: now,
		updatedAt: now,
	}
	state.threads.push(thread)
	return thread
}

export function replyToThread(thread: Thread, role: ThreadMessage["role"], text: string): void {
	thread.messages.push({ role, text, ts: Date.now() })
	thread.updatedAt = Date.now()
	if (role === "user" && thread.status !== "open" && thread.status !== "orphaned") {
		thread.status = "open"
	}
}

/** Record an agent's reply on a thread; status defaults to what the thread kind implies. */
export function applyAgentReply(thread: Thread, text: string, status?: ReplyStatus): void {
	replyToThread(thread, "agent", text)
	setStatus(thread, status ?? settledStatus(thread))
}

export function isInFlight(thread: Thread): boolean {
	return thread.status === "fixing" || thread.status === "asking"
}

export function setStatus(thread: Thread, status: ThreadStatus): void {
	thread.status = status
	thread.updatedAt = Date.now()
}

export function toggleKind(thread: Thread): void {
	thread.kind = thread.kind === "question" ? "fix" : "question"
	if (thread.status === "answered" || thread.status === "resolved") thread.status = "open"
	thread.updatedAt = Date.now()
}

export function removeThread(state: ReviewState, id: string): void {
	const index = state.threads.findIndex((thread) => thread.id === id)
	if (index >= 0) state.threads.splice(index, 1)
}

export function threadsForFile(state: ReviewState, path: string): Thread[] {
	return state.threads.filter((thread) => thread.path === path)
}

export function threadEnd(thread: Thread): number {
	return thread.endLine ?? thread.line
}

/** `path:42`, `path:42-48`, or just `path` for file-level comments. */
export function threadLocation(thread: Thread): string {
	if (thread.line <= 0) return thread.path
	const end = threadEnd(thread)
	return end > thread.line ? `${thread.path}:${thread.line}-${end}` : `${thread.path}:${thread.line}`
}

/** Threads displayed under this line: single-line ones on it, ranges ending on it. */
export function threadsEndingAt(
	state: ReviewState,
	path: string,
	line: number,
	side: "new" | "old",
): Thread[] {
	return state.threads.filter(
		(thread) => thread.path === path && threadEnd(thread) === line && thread.side === side,
	)
}

export function threadsAtLine(
	state: ReviewState,
	path: string,
	line: number,
	side: "new" | "old",
): Thread[] {
	return state.threads.filter(
		(thread) => thread.path === path && thread.line === line && thread.side === side,
	)
}

export function openThreads(state: ReviewState): Thread[] {
	return state.threads.filter((thread) => thread.status === "open")
}

export function dispatchStatus(thread: Thread): ThreadStatus {
	return isQuestion(thread) ? "asking" : "fixing"
}

export function settledStatus(thread: Thread): ThreadStatus {
	return isQuestion(thread) ? "answered" : "resolved"
}
