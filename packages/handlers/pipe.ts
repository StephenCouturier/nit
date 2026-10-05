import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import type { Handler } from "../core/handler.ts"

/**
 * Handlers that hand the review to whatever comes next: a pipe (`nit | claude -p`),
 * the clipboard, or a file. They never see the agent finish, so the batch stays
 * pending until replies arrive through `nit reply`, MCP or `nit settle`.
 */

function count(batch: { threadIds: string[]; id: string }): string {
	return `${batch.threadIds.length} comment(s), batch ${batch.id}`
}

export const stdout: Handler = {
	name: "stdout",
	description: "print the review as markdown, e.g. `nit | claude -p`",
	replyVia: "cli",
	sendLabel: "emit",
	async deliver({ prompt, batch }) {
		process.stdout.write(`${prompt}\n`)
		return { message: process.stdout.isTTY ? undefined : `nit: sent ${count(batch)}` }
	},
}

const CLIPBOARD_COMMANDS: [string, string[]][] = [
	["wl-copy", []],
	["xclip", ["-selection", "clipboard"]],
	["xsel", ["--clipboard", "--input"]],
	["pbcopy", []],
	["clip.exe", []],
]

export const clipboard: Handler = {
	name: "clipboard",
	description: "copy the review, to paste into a running agent",
	replyVia: "cli",
	sendLabel: "copy",
	async deliver({ prompt, batch }) {
		for (const [command, args] of CLIPBOARD_COMMANDS) {
			const result = spawnSync(command, args, { input: prompt, stdio: ["pipe", "ignore", "ignore"] })
			if (!result.error && result.status === 0) return { message: `copied review (${count(batch)}) to clipboard` }
		}
		throw new Error("no clipboard tool found (wl-copy, xclip, xsel, pbcopy)")
	},
}

export function file(path: string): Handler {
	return {
		name: "file",
		description: "write the review to a file (--out <path>)",
		replyVia: "cli",
		sendLabel: "write",
		async deliver({ prompt, batch }) {
			writeFileSync(path, `${prompt}\n`)
			return { message: `wrote review (${count(batch)}) to ${path}` }
		},
	}
}
