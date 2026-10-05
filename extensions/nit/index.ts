import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { BorderedLoader, getAgentDir } from "@earendil-works/pi-coding-agent"
import { loadConfig, loadUiPrefs, saveUiPrefs } from "../../packages/core/config.ts"
import type { Exec, ReviewScope } from "../../packages/core/git.ts"
import type { LoadedReview } from "../../packages/core/review.ts"
import { dispatchThreads, loadReview, settleBatch } from "../../packages/core/review.ts"
import { saveState } from "../../packages/core/store.ts"
import type { Thread } from "../../packages/core/threads.ts"
import { isQuestion } from "../../packages/core/threads.ts"
import { debugLog } from "../../packages/tui/debug.ts"
import { resolveKeys } from "../../packages/tui/keys.ts"
import { ReviewComponent } from "../../packages/tui/review-component.ts"

interface ParsedArgs {
	scope: ReviewScope
	baseOverride?: string
}

function parseArgs(raw: string): ParsedArgs {
	const tokens = raw.trim().split(/\s+/).filter(Boolean)
	let scope: ReviewScope = "local"
	let baseOverride: string | undefined

	for (const token of tokens) {
		if (token === "--local" || token === "-l") scope = "local"
		else if (token === "--branch" || token === "-b") scope = "branch"
		else if (!token.startsWith("-")) baseOverride = token
	}

	if (baseOverride) scope = "branch"
	return { scope, baseOverride }
}

export default function (pi: ExtensionAPI) {
	let pendingBatch: string | undefined
	let invocation = 0

	const makeExec =
		(cwd: string, signal?: AbortSignal): Exec =>
		async (command, args) => {
			const result = await pi.exec(command, args, { cwd, signal, timeout: 30_000 })
			return { stdout: result.stdout, stderr: result.stderr, code: result.code }
		}

	const host = () => ({ legacyAgentDir: getAgentDir() })

	function load(ctx: ExtensionContext, args: ParsedArgs, signal?: AbortSignal): Promise<LoadedReview> {
		return loadReview(makeExec(ctx.cwd, signal), args, host())
	}

	function lastAssistantText(ctx: ExtensionContext): string | undefined {
		const branch = ctx.sessionManager.getBranch()
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index]
			if (entry?.type !== "message") continue
			const message = entry.message as { role?: string; content?: unknown }
			if (message.role !== "assistant") continue
			const content = message.content
			if (typeof content === "string") return content
			if (Array.isArray(content)) {
				const text = content
					.filter(
						(part): part is { type: "text"; text: string } =>
							typeof part === "object" && part !== null && (part as { type?: string }).type === "text",
					)
					.map((part) => part.text)
					.join("\n")
					.trim()
				if (text) return text
			}
		}
		return undefined
	}

	pi.registerCommand("nit", {
		description: "Review uncommitted changes and send comments to the agent (--branch for the whole branch)",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "--local", label: "--local", description: "Only uncommitted changes vs HEAD (default)" },
				{ value: "--branch", label: "--branch", description: "Whole branch vs its base" },
			]
			const filtered = items.filter((item) => item.value.startsWith(prefix))
			return filtered.length > 0 ? filtered : null
		},
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/nit requires the interactive TUI", "warning")
				return
			}

			const parsed = parseArgs(args)

			const loaded = await ctx.ui.custom<LoadedReview | Error | null>(
				(tui, theme, _keybindings, done) => {
					const message =
						parsed.scope === "local" ? "Loading local changes..." : "Loading branch diff..."
					const loader = new BorderedLoader(tui, theme, message)
					loader.onAbort = () => done(null)
					load(ctx, parsed, loader.signal)
						.then((result) => done(result))
						.catch((error) => done(error instanceof Error ? error : new Error(String(error))))
					return loader
				},
			)

			if (loaded === null) return
			if (loaded instanceof Error) {
				ctx.ui.notify(`nit: ${loaded.message}`, "error")
				return
			}
			if (loaded.files.length === 0) {
				ctx.ui.notify(
					parsed.scope === "local"
						? "No uncommitted changes"
						: `No changes against ${loaded.state.baseRef}`,
					"info",
				)
				return
			}

			const dispatch: { threads: Thread[] } = { threads: [] }
			const deleted = new Set<string>()

			invocation++
			debugLog("open", {
				invocation,
				files: loaded.files.length,
				threads: loaded.state.threads.length,
				stdoutRows: process.stdout.rows,
				stdoutCols: process.stdout.columns,
			})

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new ReviewComponent({
						tui,
						theme,
						files: loaded.files,
						state: loaded.state,
						keys: resolveKeys(loadConfig().keys),
						prefs: loadUiPrefs(),
						onPrefsChange: (prefs) => void saveUiPrefs(prefs),
						onChange: (deletedId) => {
							if (deletedId) deleted.add(deletedId)
							void saveState(loaded.file, loaded.state, deleted)
						},
						onSend: (threads) => {
							dispatch.threads = threads
							done()
						},
						onClose: () => done(),
					}),
				{
					overlay: true,
					overlayOptions: { width: "96%", maxHeight: "94%", anchor: "center" },
					onHandle: (handle) => {
						debugLog("handle", { invocation, bounds: (handle as { bounds?: unknown }).bounds })
					},
				},
			)

			debugLog("closed", { invocation, dispatched: dispatch.threads.length })

			if (dispatch.threads.length === 0) return

			const { batch, prompt } = await dispatchThreads(makeExec(ctx.cwd), loaded, dispatch.threads, {
				transport: "pi",
				replyVia: "sections",
				deleted,
			})
			pendingBatch = batch.id

			const questions = dispatch.threads.filter(isQuestion).length
			pi.appendEntry("nit-dispatch", {
				batchId: batch.id,
				count: dispatch.threads.length,
				questions,
				fixes: dispatch.threads.length - questions,
				threads: dispatch.threads.map((thread) => ({
					id: thread.id,
					path: thread.path,
					line: thread.line,
					kind: thread.kind,
				})),
			})

			pi.sendUserMessage(prompt.text, ctx.isIdle() ? undefined : { deliverAs: "followUp" })
		},
	})

	pi.on("agent_settled", async (_event, ctx) => {
		if (!pendingBatch) return
		const batchId = pendingBatch
		pendingBatch = undefined

		try {
			const settled = await settleBatch(makeExec(ctx.cwd), batchId, lastAssistantText(ctx), host())
			if (!settled) return
			const flagged = settled.unanswered > 0 ? `, ${settled.unanswered} need review` : ""
			ctx.ui.notify(`nit: ${settled.batch.threadIds.length} comment(s) settled${flagged}`, "info")
		} catch {
			return
		}
	})
}
