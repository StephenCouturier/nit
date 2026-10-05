import { createInterface } from "node:readline"
import { loadBatch } from "../core/batch.ts"
import type { Exec } from "../core/git.ts"
import { buildDispatchPrompt } from "../core/render.ts"
import { loadBranchState, pendingThreads, replyToThreadById } from "../core/review.ts"
import type { ReplyStatus } from "../core/threads.ts"
import { REPLY_STATUSES, threadLocation } from "../core/threads.ts"

/**
 * Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0).
 * Lets any MCP-capable agent (Claude Code, Codex, opencode, ...) pull review
 * batches and reply per thread, instead of us parsing its free-form output.
 */

const SERVER_INFO = { name: "nit", version: "0.4.0" }
const DEFAULT_PROTOCOL = "2025-06-18"

const TOOLS = [
	{
		name: "review_list_pending",
		description:
			"List review comments the developer has sent you that still need a reply, grouped by batch. Call this when asked to address review comments.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "review_get",
		description: "Get the full review prompt for a batch: each comment with file:line, quoted source, and thread id.",
		inputSchema: {
			type: "object",
			properties: { batchId: { type: "string" } },
			required: ["batchId"],
			additionalProperties: false,
		},
	},
	{
		name: "review_reply",
		description:
			"Reply to one review thread after handling it. Call once per thread. status: resolved (fixed), answered (question answered), wontfix (you disagree; explain why), needs_info (comment unclear; ask).",
		inputSchema: {
			type: "object",
			properties: {
				threadId: { type: "string" },
				text: { type: "string", description: "What you changed, or your answer." },
				status: { type: "string", enum: [...REPLY_STATUSES] },
			},
			required: ["threadId", "text"],
			additionalProperties: false,
		},
	},
]

type Json = Record<string, unknown>

async function callTool(exec: Exec, name: string, args: Json): Promise<string> {
	if (name === "review_list_pending") {
		const { batches, threads } = await pendingThreads(exec)
		if (threads.length === 0) return "No pending review comments."
		return JSON.stringify(
			batches.map((batch) => ({
				batchId: batch.id,
				threads: threads
					.filter((thread) => batch.threadIds.includes(thread.id))
					.map((thread) => ({
						threadId: thread.id,
						location: threadLocation(thread),
						kind: thread.kind,
						comment: thread.messages.find((message) => message.role === "user")?.text ?? "",
					})),
			})),
			null,
			2,
		)
	}

	if (name === "review_get") {
		const batchId = String(args.batchId ?? "")
		const { repo, state } = await loadBranchState(exec)
		const batch = await loadBatch(repo.root, repo.branch, batchId)
		if (!batch) throw new Error(`no batch ${batchId} on ${repo.branch}`)
		const threads = batch.threadIds
			.map((id) => state.threads.find((thread) => thread.id === id))
			.filter((thread) => thread !== undefined)
		if (batch.replyVia === "tool" && batch.prompt) return batch.prompt
		return buildDispatchPrompt(threads, batch.baseRef, { replyVia: "tool" }).text
	}

	if (name === "review_reply") {
		const status = args.status as ReplyStatus | undefined
		if (status && !REPLY_STATUSES.includes(status)) throw new Error(`invalid status ${status}`)
		const thread = await replyToThreadById(exec, String(args.threadId ?? ""), String(args.text ?? ""), {
			status,
			source: "tool",
		})
		return `Recorded reply on ${thread.id} (${threadLocation(thread)}) as ${thread.status}.`
	}

	throw new Error(`unknown tool ${name}`)
}

export async function runMcpServer(exec: Exec): Promise<void> {
	const send = (message: Json) => process.stdout.write(`${JSON.stringify(message)}\n`)
	const rl = createInterface({ input: process.stdin })

	for await (const line of rl) {
		if (!line.trim()) continue
		let request: Json
		try {
			request = JSON.parse(line) as Json
		} catch {
			send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })
			continue
		}

		const id = request.id
		const method = String(request.method ?? "")
		const params = (request.params ?? {}) as Json
		if (id === undefined) continue // notification (e.g. notifications/initialized)

		try {
			let result: unknown
			if (method === "initialize") {
				result = {
					protocolVersion: (params.protocolVersion as string) ?? DEFAULT_PROTOCOL,
					capabilities: { tools: {} },
					serverInfo: SERVER_INFO,
				}
			} else if (method === "ping") {
				result = {}
			} else if (method === "tools/list") {
				result = { tools: TOOLS }
			} else if (method === "tools/call") {
				try {
					const text = await callTool(exec, String(params.name), (params.arguments ?? {}) as Json)
					result = { content: [{ type: "text", text }] }
				} catch (error) {
					result = { content: [{ type: "text", text: (error as Error).message }], isError: true }
				}
			} else {
				send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } })
				continue
			}
			send({ jsonrpc: "2.0", id, result })
		} catch (error) {
			send({ jsonrpc: "2.0", id, error: { code: -32603, message: (error as Error).message } })
		}
	}
}
