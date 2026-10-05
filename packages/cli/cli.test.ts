import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const CLI = fileURLToPath(new URL("./nit.ts", import.meta.url))

function nit(args: string[], input?: string) {
	return spawnSync(process.execPath, [CLI, ...args], { input, encoding: "utf-8" })
}

test("--help prints usage; unknown commands fail", () => {
	const help = nit(["--help"])
	assert.equal(help.status, 0)
	assert.match(help.stdout, /^nit \[review\]/)
	assert.equal(nit(["frobnicate"]).status, 1)
})

test("the MCP server initializes and lists its tools", () => {
	const requests = [
		{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
		{ jsonrpc: "2.0", method: "notifications/initialized" },
		{ jsonrpc: "2.0", id: 2, method: "tools/list" },
		{ jsonrpc: "2.0", id: 3, method: "bogus" },
	]
	const { stdout } = nit(["mcp"], requests.map((request) => JSON.stringify(request)).join("\n"))
	const [init, list, bogus] = stdout.trim().split("\n").map((line) => JSON.parse(line))
	assert.equal(init.result.serverInfo.name, "nit")
	assert.deepEqual(list.result.tools.map((tool: { name: string }) => tool.name), ["review_list_pending", "review_get", "review_reply"])
	assert.equal(bogus.error.code, -32601)
})
