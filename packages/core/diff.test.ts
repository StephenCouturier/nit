import assert from "node:assert/strict"
import { test } from "node:test"
import { anchorLine, countChanges, fileDiffHash, findLineText, parseUnifiedDiff } from "./diff.ts"

const RAW = `diff --git a/f b/f
--- a/f
+++ b/f
@@ -1,3 +1,4 @@ ctx
 a
-b
+B
+c
 d
`

test("parses hunk headers and numbers both sides", () => {
	const file = parseUnifiedDiff(RAW, "f")
	assert.equal(file.hunks.length, 1)
	const hunk = file.hunks[0]!
	assert.deepEqual([hunk.oldStart, hunk.oldCount, hunk.newStart, hunk.newCount], [1, 3, 1, 4])
	assert.deepEqual(
		hunk.lines.map((line) => [line.origin, line.oldNo, line.newNo, line.text]),
		[
			["context", 1, 1, "a"],
			["del", 2, null, "b"],
			["add", null, 2, "B"],
			["add", null, 3, "c"],
			["context", 3, 4, "d"],
		],
	)
})

test("flags binary files and tolerates empty input", () => {
	assert.equal(parseUnifiedDiff("Binary files a/x and b/x differ\n", "x").binary, true)
	assert.deepEqual(parseUnifiedDiff("", "x").hunks, [])
})

test("anchors, counts and looks up lines", () => {
	const file = parseUnifiedDiff(RAW, "f")
	const [, del, add] = file.hunks[0]!.lines
	assert.deepEqual(anchorLine(del!), { line: 2, side: "old" })
	assert.deepEqual(anchorLine(add!), { line: 2, side: "new" })
	assert.deepEqual(countChanges(file), { added: 2, removed: 1 })
	assert.equal(findLineText(file, 3, "new"), "c")
	assert.equal(findLineText(file, 2, "old"), "b")
	assert.equal(findLineText(file, 99, "new"), undefined)
})

test("diff hash is stable and changes with content", () => {
	const hash = fileDiffHash(parseUnifiedDiff(RAW, "f"))
	assert.equal(fileDiffHash(parseUnifiedDiff(RAW, "f")), hash)
	assert.notEqual(fileDiffHash(parseUnifiedDiff(RAW.replace("+c", "+C"), "f")), hash)
})
