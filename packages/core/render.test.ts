import assert from "node:assert/strict"
import { test } from "node:test"
import { parseUnifiedDiff } from "./diff.ts"
import { buildDispatchPrompt, diffSnippet, parseAgentSections } from "./render.ts"
import { addThread, createState } from "./threads.ts"

const RAW = `@@ -1,3 +1,4 @@
 a
-b
+B
+c
 d
`

test("parses numbered sections in their common spellings", () => {
	const sections = parseAgentSections("intro\n### 1. Fixed it\n\nmore detail\n## 2) answer\n#### 3: third")
	assert.deepEqual([...sections], [
		[1, "Fixed it\nmore detail"],
		[2, "answer"],
		[3, "third"],
	])
	assert.equal(parseAgentSections("no sections here").size, 0)
})

test("snippets mark the commented lines and number them on the thread's side", () => {
	const state = createState("/repo", "main", "HEAD")
	const thread = addThread(state, { path: "f", line: 3, side: "new", anchorText: "c", kind: "fix", text: "x" })
	assert.equal(diffSnippet(thread, parseUnifiedDiff(RAW, "f"), 1), ["```diff", "+ 2 │ B", "+ 3 ┃ c", "  4 │ d", "```"].join("\n"))
})

test("prompts number fixes before questions and give reply instructions", () => {
	const state = createState("/repo", "main", "HEAD")
	const add = (path: string, line: number, kind: "fix" | "question") =>
		addThread(state, { path, line, side: "new", anchorText: "x", kind, text: `${kind} ${path}:${line}` })
	const question = add("a.ts", 1, "question")
	const late = add("b.ts", 5, "fix")
	const early = add("a.ts", 9, "fix")

	const prompt = buildDispatchPrompt(state.threads, "origin/main", { replyVia: "cli", nitCommand: "/opt/nit" })
	assert.deepEqual(prompt.order, [early.id, late.id, question.id])
	assert.ok(prompt.text.indexOf("## Fix these") < prompt.text.indexOf("## Answer these"))
	assert.match(prompt.text, /### 3\. `a\.ts:1`/)
	assert.match(prompt.text, /\/opt\/nit reply <threadId>/)
	assert.match(prompt.text, /diffed against `origin\/main`/)
})

test("header and footer templates are filled", () => {
	const state = createState("/repo", "main", "HEAD")
	addThread(state, { path: "a", line: 1, side: "new", anchorText: "", kind: "question", text: "why" })
	const { text } = buildDispatchPrompt(state.threads, "base", {
		branch: "feat",
		templates: { header: "{count}/{questions} on {branch}", footer: "bye {fixes}" },
	})
	assert.ok(text.startsWith("1/1 on feat"))
	assert.ok(text.endsWith("bye 0"))
})
