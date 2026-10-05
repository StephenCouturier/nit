import assert from "node:assert/strict"
import { test } from "node:test"
import type { Thread } from "./threads.ts"
import { addThread, applyAgentReply, createState, migrateThread, replyToThread, threadLocation, toggleKind } from "./threads.ts"

function thread(input: Partial<Parameters<typeof addThread>[1]> = {}): Thread {
	return addThread(createState("/repo", "main", "HEAD"), {
		path: "a.ts",
		line: 3,
		side: "new",
		anchorText: "x",
		kind: "fix",
		text: "fix it",
		...input,
	})
}

test("locations cover single lines, ranges and whole files", () => {
	assert.equal(threadLocation(thread()), "a.ts:3")
	assert.equal(threadLocation(thread({ endLine: 7 })), "a.ts:3-7")
	assert.equal(threadLocation(thread({ line: 0 })), "a.ts")
	// A range that doesn't extend past its start is a single-line comment.
	assert.equal(thread({ endLine: 3 }).endLine, undefined)
})

test("agent replies settle by kind unless a status is given", () => {
	const fix = thread()
	applyAgentReply(fix, "done")
	assert.equal(fix.status, "resolved")

	const question = thread({ kind: "question" })
	applyAgentReply(question, "because")
	assert.equal(question.status, "answered")

	const disputed = thread()
	applyAgentReply(disputed, "no", "wontfix")
	assert.equal(disputed.status, "wontfix")
	assert.deepEqual(disputed.messages.map((message) => message.role), ["user", "agent"])
})

test("a reviewer reply reopens a settled thread", () => {
	const settled = thread()
	applyAgentReply(settled, "done")
	replyToThread(settled, "user", "not quite")
	assert.equal(settled.status, "open")
})

test("toggling kind reopens a done thread", () => {
	const settled = thread()
	applyAgentReply(settled, "done")
	toggleKind(settled)
	assert.equal(settled.kind, "question")
	assert.equal(settled.status, "open")
})

test("legacy severities migrate to kinds", () => {
	const legacy = { ...thread(), kind: undefined, severity: "question" } as unknown as Thread
	assert.equal(migrateThread(legacy).kind, "question")
	assert.equal("severity" in legacy, false)
})
