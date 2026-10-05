import assert from "node:assert/strict"
import { test } from "node:test"
import { agentSpecs, resolveHandler } from "./index.ts"

test("resolves pipes, agents and mode suffixes", () => {
	assert.equal(resolveHandler("stdout").name, "stdout")
	assert.equal(resolveHandler("file", { out: "/tmp/x" }).name, "file")
	const headless = resolveHandler("claude:headless")
	assert.deepEqual([headless.name, headless.replyVia], ["claude:headless", "sections"])
	assert.equal(resolveHandler("codex", { mode: "continue" }).name, "codex:continue")
})

test("rejects bad handler names, modes and missing --out", () => {
	assert.throws(() => resolveHandler("file"), /needs --out/)
	assert.throws(() => resolveHandler("nope"), /unknown handler "nope"/)
	assert.throws(() => resolveHandler("claude:sideways"), /unknown mode/)
})

test("config adds agents and overrides built-ins field by field", () => {
	const specs = agentSpecs({ handlers: { claude: { headless: ["x"] }, aider: { start: ["aider", "{prompt}"] } } })
	assert.deepEqual(specs.claude!.headless, ["x"])
	assert.deepEqual(specs.claude!.start, ["claude", "{prompt}"])
	assert.ok(specs.aider)
	assert.throws(() => agentSpecs({ handlers: { stdout: {} } }), /built-in handler/)
})
