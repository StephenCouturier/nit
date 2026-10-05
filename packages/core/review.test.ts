import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, test } from "node:test"
import { nodeExec } from "./exec.ts"
import type { Handler } from "./handler.ts"
import { loadBranchState, loadReview, pendingThreads, replyToThreadById, sendReview, settleBatch } from "./review.ts"
import { addThread } from "./threads.ts"

function temp(): string {
	return mkdtempSync(join(tmpdir(), "nit-test-"))
}

/** A repo with one committed file, then an uncommitted edit and an untracked file. */
function repo(): string {
	const dir = temp()
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir })
	git("init", "-q", "-b", "main")
	writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n")
	git("add", ".")
	git("commit", "-q", "--no-verify", "-m", "init")
	writeFileSync(join(dir, "a.txt"), "one\nTWO\nthree\n")
	writeFileSync(join(dir, "new.txt"), "hello\n")
	return dir
}

function handler(finalText?: string): Handler {
	return {
		name: "fake",
		description: "test",
		replyVia: "sections",
		async deliver() {
			return finalText === undefined ? {} : { finished: true, finalText }
		},
	}
}

async function reviewWithComments(dir: string) {
	const exec = nodeExec(dir)
	const loaded = await loadReview(exec, { scope: "local" })
	const question = addThread(loaded.state, { path: "new.txt", line: 1, side: "new", anchorText: "hello", kind: "question", text: "why?" })
	const fix = addThread(loaded.state, { path: "a.txt", line: 2, side: "new", anchorText: "TWO", kind: "fix", text: "lowercase" })
	return { exec, loaded, fix, question }
}

before(() => {
	process.env.NIT_HOME = temp()
	process.env.NIT_CONFIG_DIR = temp()
})

test("loads staged, unstaged and untracked changes", async () => {
	const { files } = await loadReview(nodeExec(repo()), { scope: "local" })
	assert.deepEqual(files.map((file) => file.path), ["a.txt", "new.txt"])
	assert.deepEqual(
		files[0]!.hunks[0]!.lines.filter((line) => line.origin !== "context").map((line) => line.text),
		["two", "TWO"],
	)
})

test("a headless agent's sections settle the batch", async () => {
	const { exec, loaded, fix, question } = await reviewWithComments(repo())
	const sent = await sendReview(exec, loaded, [question, fix], handler("### 1. lowered\n### 2. because"), { cwd: "." })

	assert.match(sent.prompt.text, /\+ 2 ┃ TWO/)
	assert.deepEqual(sent.batch.threadIds, [fix.id, question.id])
	assert.equal(sent.settled?.routed, 2)
	const { state } = await loadBranchState(exec)
	assert.deepEqual(state.threads.map((thread) => [thread.id, thread.status]), [
		[question.id, "answered"],
		[fix.id, "resolved"],
	])
})

test("per-thread replies clear pending; settling flags the rest", async () => {
	const { exec, loaded, fix, question } = await reviewWithComments(repo())
	const { batch } = await sendReview(exec, loaded, [fix, question], handler(), { cwd: "." })
	assert.equal((await pendingThreads(exec)).threads.length, 2)

	await replyToThreadById(exec, fix.id, "done", { source: "cli" })
	assert.deepEqual((await pendingThreads(exec)).threads.map((thread) => thread.id), [question.id])

	const settled = await settleBatch(exec, batch.id, undefined)
	assert.deepEqual([settled?.routed, settled?.unanswered, settled?.batch.status], [0, 1, "settled"])
	const { state } = await loadBranchState(exec)
	assert.equal(state.threads.find((thread) => thread.id === question.id)?.status, "needs_review")
})

test("diffs ignore the user's color config", { todo: "git diff runs without --no-color" }, async () => {
	const dir = repo()
	execFileSync("git", ["config", "color.ui", "always"], { cwd: dir })
	const { files } = await loadReview(nodeExec(dir), { scope: "local" })
	assert.equal(files[0]!.hunks.length, 1)
})

test("non-ASCII filenames load unquoted", { todo: "git quotes the paths; use -z" }, async () => {
	const dir = repo()
	writeFileSync(join(dir, "café.txt"), "x\n")
	const { files } = await loadReview(nodeExec(dir), { scope: "local" })
	assert.ok(files.some((file) => file.path === "café.txt"))
})
