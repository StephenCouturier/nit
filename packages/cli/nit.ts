#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { listBatches, loadBatch } from "../core/batch.ts"
import { nodeExec } from "../core/exec.ts"
import type { ReviewScope } from "../core/git.ts"
import type { ReplyVia } from "../core/render.ts"
import { buildCompactPrompt, buildDispatchPrompt } from "../core/render.ts"
import { dispatchThreads, loadBranchState, loadReview, pendingThreads, replyToThreadById, settleBatch } from "../core/review.ts"
import type { ReplyStatus } from "../core/threads.ts"
import { openThreads, REPLY_STATUSES, threadLocation } from "../core/threads.ts"
import { runMcpServer } from "./mcp.ts"
import { popup } from "./popup.ts"

const USAGE = `nit [review] [--branch] [--base <ref>] [--reply cli|tool|sections] [--copy] [--out <file>]
                         open the review TUI on uncommitted changes (--branch: the whole branch
                         vs its base); f/F writes the review as markdown to stdout
                         (or the clipboard / a file), ready to hand to any agent:
                           nit | claude -p      nit --copy      nit > review.md

nit <command>

  popup [review options] open the TUI in a herdr pane / tmux popup / floating Hyprland terminal,
                         wait for it, and print the review (for agents' slash commands)
  dispatch [--branch] [--base <ref>] [--reply sections|tool|cli] [--compact]
                         send all open threads as a new batch; prints the prompt to stdout
  pending [--json]       threads sent to an agent that have no reply yet
  show <batchId> [--reply sections|tool|cli]
                         print a batch's prompt
  reply <threadId> [--status ${REPLY_STATUSES.join("|")}] [-m <text>]
                         record an agent reply on a thread (text from -m or stdin)
  settle <batchId> [--file <path>]
                         finish a batch; route numbered sections from the agent's final message (file or stdin)
  history [--json]       past batches on this branch
  mcp                    run the MCP server on stdio
`

function flag(args: string[], ...names: string[]): string | undefined {
	for (const name of names) {
		const index = args.indexOf(name)
		if (index >= 0) return args[index + 1]
	}
	return undefined
}

function has(args: string[], ...names: string[]): boolean {
	return names.some((name) => args.includes(name))
}

/** Uncommitted changes by default; --branch (or an explicit --base) reviews the whole branch. */
function reviewScope(args: string[], base: string | undefined): ReviewScope {
	return base || has(args, "--branch", "-b") ? "branch" : "local"
}

function readStdin(): string {
	if (process.stdin.isTTY) return ""
	try {
		return readFileSync(0, "utf-8")
	} catch {
		return ""
	}
}

function replyVia(args: string[], fallback: ReplyVia): ReplyVia {
	const value = flag(args, "--reply") ?? fallback
	if (value !== "sections" && value !== "tool" && value !== "cli") throw new Error(`invalid --reply ${value}`)
	return value
}

const CLIPBOARD_COMMANDS: [string, string[]][] = [
	["wl-copy", []],
	["xclip", ["-selection", "clipboard"]],
	["xsel", ["--clipboard", "--input"]],
	["pbcopy", []],
	["clip.exe", []],
]

function copyToClipboard(text: string): boolean {
	for (const [command, args] of CLIPBOARD_COMMANDS) {
		const result = spawnSync(command, args, { input: text, stdio: ["pipe", "ignore", "ignore"] })
		if (!result.error && result.status === 0) return true
	}
	return false
}

async function review(args: string[]): Promise<void> {
	const exec = nodeExec(process.cwd())
	const base = flag(args, "--base")
	const scope = reviewScope(args, base)
	const loaded = await loadReview(exec, { scope, baseOverride: base })
	if (loaded.files.length === 0) {
		process.stderr.write(scope === "local" ? "no uncommitted changes\n" : `no changes against ${loaded.state.baseRef}\n`)
		process.exitCode = 1
		return
	}

	// Loaded lazily so the agent-facing commands (reply, mcp, ...) need no UI dependencies.
	const { runReviewTui } = await import("../tui/standalone.ts")
	const out = flag(args, "--out", "-o")
	const copy = has(args, "--copy", "-c")
	const { threads, deleted } = await runReviewTui(loaded, { sendLabel: copy ? "copy" : "emit" })
	if (threads.length === 0) {
		process.exitCode = 130
		return
	}

	const transport = copy ? "clipboard" : out ? "file" : "stdout"
	const { batch, prompt } = await dispatchThreads(exec, loaded, threads, {
		transport,
		replyVia: replyVia(args, "cli"),
		deleted,
	})

	if (copy) {
		if (!copyToClipboard(prompt.text)) throw new Error("no clipboard tool found (wl-copy, xclip, xsel, pbcopy)")
		process.stderr.write(`copied review (${threads.length} comment(s), batch ${batch.id}) to clipboard\n`)
	} else if (out) {
		writeFileSync(out, `${prompt.text}\n`)
		process.stderr.write(`wrote review (${threads.length} comment(s), batch ${batch.id}) to ${out}\n`)
	} else {
		process.stdout.write(`${prompt.text}\n`)
		if (!process.stdout.isTTY) process.stderr.write(`nit: sent ${threads.length} comment(s), batch ${batch.id}\n`)
	}
}

async function main(argv: string[]): Promise<void> {
	const [command, ...args] = argv
	const exec = nodeExec(process.cwd())

	if (command === undefined || command === "review" || command.startsWith("-")) {
		if (command === "--help" || command === "-h") {
			process.stdout.write(USAGE)
			return
		}
		await review(command === "review" ? args : argv)
		return
	}

	switch (command) {
		case "dispatch": {
			const base = flag(args, "--base")
			const loaded = await loadReview(exec, { scope: reviewScope(args, base), baseOverride: base })
			const threads = openThreads(loaded.state)
			if (threads.length === 0) {
				process.stderr.write("no open threads\n")
				process.exitCode = 1
				return
			}
			const via = replyVia(args, "cli")
			const { batch, prompt } = await dispatchThreads(exec, loaded, threads, { transport: "stdout", replyVia: via })
			process.stdout.write(`${has(args, "--compact") && via !== "sections" ? buildCompactPrompt(batch, via) : prompt.text}\n`)
			process.stderr.write(`batch ${batch.id}: ${threads.length} thread(s)\n`)
			return
		}

		case "pending": {
			const { batches, threads } = await pendingThreads(exec)
			if (has(args, "--json")) {
				process.stdout.write(`${JSON.stringify({ batches: batches.map((batch) => batch.id), threads }, null, 2)}\n`)
				return
			}
			if (threads.length === 0) {
				process.stdout.write("No pending review comments.\n")
				return
			}
			for (const thread of threads) {
				const comment = thread.messages.find((message) => message.role === "user")?.text ?? ""
				process.stdout.write(`${thread.id}  ${thread.kind.padEnd(9)} ${threadLocation(thread)}  ${comment}\n`)
			}
			return
		}

		case "show": {
			const batchId = args[0]
			if (!batchId) throw new Error("usage: nit show <batchId>")
			const { repo, state } = await loadBranchState(exec)
			const batch = await loadBatch(repo.root, repo.branch, batchId)
			if (!batch) throw new Error(`no batch ${batchId} on ${repo.branch}`)
			const threads = batch.threadIds
				.map((id) => state.threads.find((thread) => thread.id === id))
				.filter((thread) => thread !== undefined)
			const via = replyVia(args, batch.replyVia)
			const text = via === batch.replyVia && batch.prompt ? batch.prompt : buildDispatchPrompt(threads, batch.baseRef, { replyVia: via }).text
			process.stdout.write(`${text}\n`)
			return
		}

		case "reply": {
			const threadId = args[0]
			if (!threadId) throw new Error("usage: nit reply <threadId> [--status s] [-m text]")
			const status = flag(args, "--status", "-s") as ReplyStatus | undefined
			if (status && !REPLY_STATUSES.includes(status)) throw new Error(`invalid --status ${status}`)
			const text = (flag(args, "-m", "--message") ?? readStdin()).trim()
			if (!text) throw new Error("reply text is empty (use -m or stdin)")
			const thread = await replyToThreadById(exec, threadId, text, { status, source: "cli" })
			process.stdout.write(`${thread.id} ${threadLocation(thread)} -> ${thread.status}\n`)
			return
		}

		case "settle": {
			const batchId = args[0]
			if (!batchId) throw new Error("usage: nit settle <batchId> [--file path]")
			const file = flag(args, "--file", "-f")
			const text = file ? readFileSync(file, "utf-8") : readStdin()
			const settled = await settleBatch(exec, batchId, text || undefined)
			if (!settled) throw new Error(`no batch ${batchId}`)
			process.stdout.write(`batch ${batchId}: ${settled.routed} routed from sections, ${settled.unanswered} need review\n`)
			return
		}

		case "history": {
			const { repo } = await loadBranchState(exec)
			const batches = await listBatches(repo.root, repo.branch)
			if (has(args, "--json")) {
				process.stdout.write(`${JSON.stringify(batches, null, 2)}\n`)
				return
			}
			for (const batch of batches) {
				const when = new Date(batch.createdAt).toISOString().replace("T", " ").slice(0, 16)
				process.stdout.write(
					`${batch.id}  ${when}  ${batch.status.padEnd(8)} ${batch.transport.padEnd(8)} ${batch.results.length}/${batch.threadIds.length} replied\n`,
				)
			}
			return
		}

		case "popup":
			await popup(args)
			return

		case "mcp":
			await runMcpServer(exec)
			return

		default:
			process.stdout.write(USAGE)
			if (command && command !== "help" && command !== "--help" && command !== "-h") process.exitCode = 1
	}
}

main(process.argv.slice(2)).catch((error) => {
	process.stderr.write(`nit: ${(error as Error).message}\n`)
	process.exitCode = 1
})
