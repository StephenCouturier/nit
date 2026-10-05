import assert from "node:assert/strict"
import { test } from "node:test"
import { fileDiffHash, parseUnifiedDiff } from "../core/diff.ts"
import { addThread, createState } from "../core/threads.ts"
import { actionFor, matchesBinding, resolveKeys } from "./keys.ts"
import { buildRows, nextHunk, nextSelectable } from "./rows.ts"
import { parseBase16 } from "./theme.ts"

test("key overrides replace defaults; unknown actions are rejected", () => {
	const keys = resolveKeys({ send: "ctrl+s" })
	assert.deepEqual(keys.send, ["ctrl+s"])
	assert.equal(actionFor(keys, "j"), "down")
	assert.equal(matchesBinding("G", "G"), true)
	assert.equal(matchesBinding("g", "G"), false)
	assert.throws(() => resolveKeys({ nope: "x" }), /unknown key action "nope"/)
})

test("base16 schemes parse, incomplete ones are rejected", () => {
	const scheme = Array.from({ length: 16 }, (_, index) => `base0${index.toString(16).toUpperCase()}: "#00000${index.toString(16)}"`).join("\n")
	assert.equal(parseBase16(scheme)["D"], "00000d")
	assert.throws(() => parseBase16("base00: '#000000'"), /not a base16 scheme/)
})

test("rows interleave threads under their line and skip viewed files", () => {
	const file = parseUnifiedDiff("@@ -1,2 +1,2 @@\n-a\n+A\n b\n", "f")
	const state = createState("/repo", "main", "HEAD")
	addThread(state, { path: "f", line: 1, side: "new", anchorText: "A", kind: "fix", text: "hm" })

	const rows = buildRows([file], state, { split: false })
	assert.deepEqual(rows.map((row) => row.kind), ["file", "hunk", "line", "line", "thread", "line", "spacer"])
	assert.equal(nextSelectable(rows, 0, 1), 2)
	assert.equal(nextHunk(rows, 4, -1), 2)

	const split = buildRows([file], state, { split: true })
	assert.deepEqual(split.map((row) => row.kind), ["file", "hunk", "pair", "thread", "pair", "spacer"])

	state.viewed = { f: fileDiffHash(file) }
	assert.deepEqual(buildRows([file], state, { split: false }).map((row) => row.kind), ["file", "spacer"])
	state.viewed = { f: "stale" }
	const [header] = buildRows([file], state, { split: false })
	assert.equal(header?.kind === "file" && header.view, "changed")
})
