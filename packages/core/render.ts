import type { ReviewBatch } from "./batch.ts"
import type { Templates } from "./config.ts"
import { fillTemplate } from "./config.ts"
import type { DiffLine, FileDiff } from "./diff.ts"
import type { Thread } from "./threads.ts"
import { isQuestion, REPLY_STATUSES, threadEnd, threadLocation } from "./threads.ts"

/**
 * How the agent should report back per thread.
 * - sections: numbered `### N.` sections in its final message (parsed afterwards)
 * - tool: call the `review_reply` MCP tool once per thread
 * - cli: run `nit reply <threadId> ...` once per thread
 */
export type ReplyVia = "sections" | "tool" | "cli"

export interface RenderOptions {
	replyVia?: ReplyVia
	/** When given, each comment quotes the surrounding diff with line numbers instead of just its anchor line. */
	files?: Map<string, FileDiff>
	/** Diff lines of context shown around the commented lines. */
	context?: number
	/** User overrides for the opening line and closing guidelines (see config.ts). */
	templates?: Templates
	branch?: string
}

const DEFAULT_HEADER = "I reviewed the current branch (diffed against `{base}`) and left {count} comment(s)."

const DEFAULT_FOOTER = [
	"Guidelines:",
	"- Fix items: change the code directly, do not just describe the fix.",
	"- Question items: answer only. Do not edit files to answer a question.",
	"- If a comment is wrong or you disagree, say so instead of making the change.",
	"- Keep changes scoped to the comment; do not refactor unrelated code.",
].join("\n")

const DEFAULT_CONTEXT = 3

/**
 * The commented lines plus surrounding context from the hunk that contains them, as a
 * ```diff block. Numbers are on the thread's side (new file unless it was left on a
 * removed line); lines with no number on that side are left blank. Commented lines use
 * a heavy bar so the agent can see exactly which ones the comment is about.
 */
export function diffSnippet(thread: Thread, file: FileDiff, context = DEFAULT_CONTEXT): string | undefined {
	if (thread.line <= 0) return undefined
	const end = threadEnd(thread)
	const numberOf = (line: DiffLine) => (thread.side === "old" ? line.oldNo : line.newNo)

	for (const hunk of file.hunks) {
		const startIndex = hunk.lines.findIndex((line) => numberOf(line) === thread.line)
		if (startIndex < 0) continue
		let endIndex = startIndex
		for (let index = startIndex; index < hunk.lines.length; index++) {
			if (numberOf(hunk.lines[index]!) === end) {
				endIndex = index
				break
			}
		}

		const from = Math.max(0, startIndex - context)
		const to = Math.min(hunk.lines.length - 1, endIndex + context)
		const slice = hunk.lines.slice(from, to + 1)
		const width = Math.max(...slice.map((line) => String(numberOf(line) ?? "").length), 1)

		const body = slice.map((line, offset) => {
			const index = from + offset
			const sign = line.origin === "add" ? "+" : line.origin === "del" ? "-" : " "
			const no = String(numberOf(line) ?? "").padStart(width)
			const bar = index >= startIndex && index <= endIndex ? "┃" : "│"
			return `${sign} ${no} ${bar} ${line.text}`
		})
		return ["```diff", ...body, "```"].join("\n")
	}
	return undefined
}

export interface DispatchPrompt {
	text: string
	order: string[]
}

function formatThread(thread: Thread, options: RenderOptions): string {
	const lines: string[] = []
	const firstIndex = thread.messages.findIndex((message) => message.role === "user")
	const first = firstIndex >= 0 ? thread.messages[firstIndex] : undefined
	const side = thread.side === "old" && thread.line > 0 ? " (removed lines, old numbering)" : ""
	lines.push(`\`${threadLocation(thread)}\`${side} (thread \`${thread.id}\`)`)
	const file = options.files?.get(thread.path)
	const snippet = file ? diffSnippet(thread, file, options.context) : undefined
	if (snippet) {
		lines.push("")
		lines.push(snippet)
	} else if (thread.anchorText.trim()) {
		lines.push("")
		lines.push("```")
		lines.push(thread.anchorText)
		lines.push("```")
	}
	lines.push("")
	lines.push(first?.text ?? "")
	const rest = thread.messages.slice(firstIndex + 1)
	for (const message of rest) {
		lines.push("")
		lines.push(`> ${message.role === "user" ? "Reviewer" : "You"}: ${message.text.replace(/\n/g, "\n> ")}`)
	}
	return lines.join("\n")
}

export function sortThreads(threads: Thread[]): Thread[] {
	return [...threads].sort((a, b) => {
		if (a.path !== b.path) return a.path.localeCompare(b.path)
		return a.line - b.line
	})
}

/** Fixes first, then questions, each sorted by path/line. This is the numbering the agent sees. */
export function dispatchOrder(threads: Thread[]): Thread[] {
	return [
		...sortThreads(threads.filter((thread) => !isQuestion(thread))),
		...sortThreads(threads.filter((thread) => isQuestion(thread))),
	]
}

function respondFooter(replyVia: ReplyVia): string[] {
	const statuses = REPLY_STATUSES.join(" | ")
	if (replyVia === "tool") {
		return [
			"## How to respond",
			"",
			"For every thread above, call the `review_reply` tool once with its thread id, a short summary of what you changed (or your answer), and a status:",
			`\`${statuses}\`. Use \`wontfix\` if you disagree, \`needs_info\` if the comment is unclear.`,
		]
	}
	if (replyVia === "cli") {
		return [
			"## How to respond",
			"",
			"For every thread above, run once:",
			"",
			"```",
			`nit reply <threadId> --status <${statuses}> -m "<what you changed, or your answer>"`,
			"```",
			"",
			"Use `wontfix` if you disagree, `needs_info` if the comment is unclear.",
		]
	}
	return [
		"## How to respond",
		"",
		"Reply with one section per comment, numbered exactly as above:",
		"",
		"```",
		"### 1. <what you changed, or your answer>",
		"### 2. ...",
		"```",
	]
}

export function buildDispatchPrompt(
	threads: Thread[],
	baseRef: string,
	options: RenderOptions = {},
): DispatchPrompt {
	const replyVia = options.replyVia ?? "sections"
	const order = dispatchOrder(threads)
	const fixes = order.filter((thread) => !isQuestion(thread))
	const questions = order.filter((thread) => isQuestion(thread))

	const values = {
		count: order.length,
		fixes: fixes.length,
		questions: questions.length,
		base: baseRef,
		branch: options.branch ?? "",
	}
	const header = fillTemplate(options.templates?.header ?? DEFAULT_HEADER, values)

	const sections: string[] = []
	let counter = 0

	if (fixes.length > 0) {
		const body = fixes
			.map((thread) => {
				counter++
				return `### ${counter}. ${formatThread(thread, options)}`
			})
			.join("\n\n")
		sections.push(`## Fix these\n\nChange the code to address each item below.\n\n${body}`)
	}

	if (questions.length > 0) {
		const body = questions
			.map((thread) => {
				counter++
				return `### ${counter}. ${formatThread(thread, options)}`
			})
			.join("\n\n")
		sections.push(
			`## Answer these\n\nThese are questions, not change requests. Do NOT modify any files for them. Investigate and answer.\n\n${body}`,
		)
	}

	// The reply instructions are not templated: the round trip depends on them.
	const footer = [
		...respondFooter(replyVia),
		"",
		fillTemplate(options.templates?.footer ?? DEFAULT_FOOTER, values),
	].join("\n")

	return {
		text: `${header}\n\n${sections.join("\n\n")}\n\n${footer}`,
		order: order.map((thread) => thread.id),
	}
}

/**
 * A short pointer prompt for transports where pasting the full review is awkward
 * (PTY injection, slash commands). The agent pulls the batch itself.
 */
export function buildCompactPrompt(batch: ReviewBatch, replyVia: Exclude<ReplyVia, "sections">): string {
	const count = batch.threadIds.length
	const fetch =
		replyVia === "tool"
			? `Call the \`review_get\` tool with batchId \`${batch.id}\``
			: `Run \`nit show ${batch.id}\``
	const reply = replyVia === "tool" ? "`review_reply`" : "`nit reply`"
	return `I left ${count} review comment${count === 1 ? "" : "s"} on this branch. ${fetch} to read them, address each one, and report back per thread with ${reply}.`
}

export function parseAgentSections(reply: string): Map<number, string> {
	const sections = new Map<number, string>()
	const pattern = /^#{1,4}\s*(\d+)[.):]?\s*(.*)$/gm
	const matches = [...reply.matchAll(pattern)]

	for (let index = 0; index < matches.length; index++) {
		const match = matches[index]!
		const number = Number.parseInt(match[1]!, 10)
		const start = (match.index ?? 0) + match[0].length
		const end = index + 1 < matches.length ? (matches[index + 1]!.index ?? reply.length) : reply.length
		const inline = (match[2] ?? "").trim()
		const body = reply.slice(start, end).trim()
		const text = [inline, body].filter(Boolean).join("\n").trim()
		if (text) sections.set(number, text)
	}

	return sections
}
