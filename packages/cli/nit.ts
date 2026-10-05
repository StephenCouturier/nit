#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { listBatches, loadBatch } from "../core/batch.ts"
import { loadConfig } from "../core/config.ts"
import { nodeExec } from "../core/exec.ts"
import type { ReviewScope } from "../core/git.ts"
import type { AgentMode, Handler } from "../core/handler.ts"
import type { ReplyVia } from "../core/render.ts"
import { buildCompactPrompt, buildDispatchPrompt } from "../core/render.ts"
import type { Sent } from "../core/review.ts"
import { loadBranchState, loadReview, pendingThreads, replyToThreadById, sendReview, settleBatch } from "../core/review.ts"
import type { ReplyStatus } from "../core/threads.ts"
import { openThreads, REPLY_STATUSES, threadLocation } from "../core/threads.ts"
import { listHandlers, nitCommand, resolveHandler } from "../handlers/index.ts"
import { stdout } from "../handlers/pipe.ts"
import { INSTALLABLE, install } from "../handlers/install.ts"
import { runMcpServer } from "./mcp.ts"
import { popup } from "./popup.ts"

const USAGE = `nit [review] [--to <handler>] [--continue | --headless] [--branch] [--base <ref>]
    [--reply cli|tool|sections] [--copy] [--out <file>]
                         open the review TUI on uncommitted changes (--branch: the whole branch
                         vs its base); F sends the review to a handler:
                           nit                  markdown on stdout: nit | claude -p
                           nit --copy           the clipboard (--to clipboard)
                           nit --out review.md  a file (--to file)
                           nit --to claude      a new agent session seeded with the review
                           nit --to codex --continue
                                                the agent's last session here, which knows its changes
                           nit --to pi --headless
                                                run the agent to completion and settle from its output
                         The default handler is "handler" in config.json, else stdout.

nit <command>

  handlers               list handlers (built-in and from config.json) and whether they're installed
  install <agent> [--project] [--force]
                         add a /nit command to ${INSTALLABLE.join(", ")}
  popup [review options] open the TUI in a herdr pane / tmux popup / floating Hyprland terminal,
                         wait for it, and print the review (for agents' slash commands)
  dispatch [--to <handler>] [--branch] [--base <ref>] [--reply sections|tool|cli] [--compact]
                         send all open threads as a new batch without the TUI (default: stdout)
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

function replyVia(args: string[]): ReplyVia | undefined {
	const value = flag(args, "--reply")
	if (value !== undefined && value !== "sections" && value !== "tool" && value !== "cli") throw new Error(`invalid --reply ${value}`)
	return value
}

function agentMode(args: string[]): AgentMode | undefined {
	if (has(args, "--headless")) return "headless"
	if (has(args, "--continue")) return "continue"
	return undefined
}

/** Explicit flags win over the configured default: --to, then --copy / --out, then config "handler", then stdout. */
function chooseHandler(args: string[]): Handler {
	const config = loadConfig()
	const out = flag(args, "--out", "-o")
	const name = flag(args, "--to", "-t") ?? (has(args, "--copy", "-c") ? "clipboard" : out ? "file" : (config.handler ?? "stdout"))
	const handler = resolveHandler(name, { mode: agentMode(args), out, config })
	handler.preflight?.()
	return handler
}

function report(sent: Sent): void {
	if (sent.delivered.message) process.stderr.write(`${sent.delivered.message}\n`)
	if (sent.settled) {
		const { batch, routed, unanswered } = sent.settled
		const replied = batch.threadIds.length - routed - unanswered
		const flagged = unanswered > 0 ? `, ${unanswered} need review (no reply)` : ""
		process.stderr.write(`nit: batch ${batch.id} settled: ${replied} replied, ${routed} from sections${flagged}\n`)
	}
}

async function review(args: string[]): Promise<void> {
	const exec = nodeExec(process.cwd())
	const base = flag(args, "--base")
	const scope = reviewScope(args, base)
	// Before the TUI, so a missing agent doesn't cost the user their review session.
	const handler = chooseHandler(args)
	const loaded = await loadReview(exec, { scope, baseOverride: base })
	if (loaded.files.length === 0) {
		process.stderr.write(scope === "local" ? "no uncommitted changes\n" : `no changes against ${loaded.state.baseRef}\n`)
		process.exitCode = 1
		return
	}

	// Loaded lazily so the agent-facing commands (reply, mcp, ...) need no UI dependencies.
	const { runReviewTui } = await import("../tui/standalone.ts")
	const { threads, deleted } = await runReviewTui(loaded, { sendLabel: handler.sendLabel })
	if (threads.length === 0) {
		process.exitCode = 130
		return
	}

	report(
		await sendReview(exec, loaded, threads, handler, {
			cwd: process.cwd(),
			replyVia: replyVia(args),
			deleted,
			nitCommand: nitCommand(),
		}),
	)
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
			let handler = flag(args, "--to", "-t") || flag(args, "--out", "-o") || has(args, "--copy", "-c") ? chooseHandler(args) : stdout
			const loaded = await loadReview(exec, { scope: reviewScope(args, base), baseOverride: base })
			const threads = openThreads(loaded.state)
			if (threads.length === 0) {
				process.stderr.write("no open threads\n")
				process.exitCode = 1
				return
			}
			const via = replyVia(args) ?? handler.replyVia
			if (has(args, "--compact") && via !== "sections") {
				const nit = nitCommand()
				const inner = handler
				handler = { ...inner, deliver: (delivery) => inner.deliver({ ...delivery, prompt: buildCompactPrompt(delivery.batch, via, nit) }) }
			}
			const sent = await sendReview(exec, loaded, threads, handler, { cwd: process.cwd(), replyVia: via, nitCommand: nitCommand() })
			process.stderr.write(`batch ${sent.batch.id}: ${threads.length} thread(s)\n`)
			report(sent)
			return
		}

		case "handlers": {
			const handlers = listHandlers(loadConfig())
			const width = Math.max(...handlers.map((handler) => handler.name.length))
			for (const handler of handlers) {
				const modes = handler.modes.length > 0 ? ` [${handler.modes.join(", ")}]` : ""
				const missing = handler.available ? "" : " (not installed)"
				process.stdout.write(`${handler.name.padEnd(width)}  ${handler.description}${modes}${missing}\n`)
			}
			return
		}

		case "install": {
			const agent = args[0]
			if (!agent || agent.startsWith("-")) throw new Error(`usage: nit install <${INSTALLABLE.join("|")}> [--project] [--force]`)
			const lines = install(agent, {
				project: has(args, "--project"),
				force: has(args, "--force"),
				cwd: process.cwd(),
				nit: nitCommand(),
			})
			for (const line of lines) process.stdout.write(`${line}\n`)
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
			const via = replyVia(args) ?? batch.replyVia
			const text =
				via === batch.replyVia && batch.prompt
					? batch.prompt
					: buildDispatchPrompt(threads, batch.baseRef, { replyVia: via, nitCommand: nitCommand() }).text
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
					`${batch.id}  ${when}  ${batch.status.padEnd(8)} ${batch.transport.padEnd(16)} ${batch.results.length}/${batch.threadIds.length} replied\n`,
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
