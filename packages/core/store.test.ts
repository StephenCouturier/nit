import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { parseUnifiedDiff } from "./diff.ts"
import { reanchorThreads, saveState } from "./store.ts"
import type { Thread } from "./threads.ts"
import { addThread, applyAgentReply, createState } from "./threads.ts"

// "keep" moved from line 2 to line 4; line 1 is blank.
const FILE = parseUnifiedDiff("@@ -1,2 +1,4 @@\n \n+new\n+new\n keep\n", "f")

function stateWith(input: Partial<Parameters<typeof addThread>[1]>) {
	const state = createState("/repo", "main", "HEAD")
	const thread = addThread(state, { path: "f", line: 2, side: "new", anchorText: "keep", kind: "fix", text: "x", ...input })
	return { state, thread }
}

test("threads follow their line to the nearest match", () => {
	const { state, thread } = stateWith({ endLine: 3 })
	reanchorThreads(state, new Map([["f", FILE]]))
	assert.deepEqual([thread.line, thread.endLine, thread.status], [4, 5, "open"])
})

test("threads whose line or file is gone are flagged, then recover", () => {
	const { state, thread } = stateWith({ anchorText: "gone" })
	reanchorThreads(state, new Map([["f", FILE]]))
	assert.equal(thread.status, "orphaned")
	thread.anchorText = "keep"
	reanchorThreads(state, new Map([["f", FILE]]))
	assert.equal(thread.status, "open")

	const resolved = stateWith({})
	applyAgentReply(resolved.thread, "done")
	reanchorThreads(resolved.state, new Map())
	assert.equal(resolved.thread.status, "resolved")
})

test("file-level comments stay file-level", { todo: "reanchor matches the empty anchorText to a blank line" }, () => {
	const { state, thread } = stateWith({ line: 0, anchorText: "" })
	reanchorThreads(state, new Map([["f", FILE]]))
	assert.equal(thread.line, 0)
})

test("a settled question keeps its status when its file leaves the diff", { todo: "orphaned overwrites the status, then reopens" }, () => {
	const { state, thread } = stateWith({ kind: "question" })
	applyAgentReply(thread, "because")
	reanchorThreads(state, new Map())
	reanchorThreads(state, new Map([["f", FILE]]))
	assert.equal(thread.status, "answered")
})

function tempFile(): string {
	return join(mkdtempSync(join(tmpdir(), "nit-test-")), "state.json")
}

test("saves merge with disk: newer disk replies win, deletions stick", async () => {
	const file = tempFile()
	const disk = createState("/repo", "main", "HEAD")
	const replied = addThread(disk, { path: "f", line: 1, side: "new", anchorText: "", kind: "fix", text: "a" })
	const other = addThread(disk, { path: "f", line: 2, side: "new", anchorText: "", kind: "fix", text: "b" })
	const doomed = addThread(disk, { path: "f", line: 3, side: "new", anchorText: "", kind: "fix", text: "c" })
	const memory = structuredClone(disk)
	applyAgentReply(replied, "from the agent")
	replied.updatedAt += 1000
	writeFileSync(file, JSON.stringify(disk))

	memory.threads = memory.threads.filter((thread) => thread.id !== other.id)
	await saveState(file, memory, [doomed.id])

	const saved = JSON.parse(readFileSync(file, "utf-8")).threads as Thread[]
	assert.deepEqual(saved.map((thread) => thread.id), [replied.id, other.id])
	assert.equal(saved[0]!.status, "resolved")
})

test("overlapping saves don't reject", { todo: "every save shares one temp file name" }, async () => {
	const file = tempFile()
	const state = createState("/repo", "main", "HEAD")
	await Promise.all(Array.from({ length: 20 }, () => saveState(file, state)))
})
