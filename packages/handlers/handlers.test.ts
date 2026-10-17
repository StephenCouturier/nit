import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { agentSpecs, resolveHandler } from "./index.ts"
import { buildVsix } from "./vsix.ts"

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

test("the VS Code extension packs into a readable .vsix", () => {
	const dir = mkdtempSync(join(tmpdir(), "nit-test-"))
	try {
		const vsix = join(dir, "nit.vsix")
		writeFileSync(vsix, buildVsix(fileURLToPath(new URL("../../integrations/vscode", import.meta.url))))
		const check = "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print('\\n'.join(z.namelist()))"
		const result = spawnSync("python3", ["-I", "-c", check, vsix], { encoding: "utf-8" })
		if (result.error) return // no python to check with
		assert.equal(result.status, 0, result.stderr)
		assert.deepEqual(result.stdout.trim().split("\n"), [
			"extension.vsixmanifest",
			"[Content_Types].xml",
			"extension/package.json",
			"extension/extension.js",
		])
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
