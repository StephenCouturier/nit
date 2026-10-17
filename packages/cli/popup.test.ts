import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const CLI = fileURLToPath(new URL("./nit.ts", import.meta.url))

function popup(socket: string, extra: NodeJS.ProcessEnv = {}): Promise<{ status: number | null; stdout: string }> {
	const env: NodeJS.ProcessEnv = { ...process.env, NIT_VSCODE_SOCKET: socket }
	for (const key of ["HERDR_PANE_ID", "TMUX", "HYPRLAND_INSTANCE_SIGNATURE", "NIT_VSCODE_AGENT", "TERM_PROGRAM"]) delete env[key]
	Object.assign(env, extra)
	const child = spawn(process.execPath, [CLI, "popup"], { env, stdio: ["ignore", "pipe", "inherit"] })
	let stdout = ""
	child.stdout.on("data", (chunk) => (stdout += chunk))
	return new Promise((resolve) => child.on("close", (status) => resolve({ status, stdout })))
}

for (const [name, extra] of [
	["", {}],
	[" ahead of a herdr pane VS Code inherited", { NIT_VSCODE_AGENT: "1", HERDR_PANE_ID: "bogus", PATH: "/nonexistent" }],
] as const)
test(`popup hands the review script to the VS Code extension${name} and prints its review`, async () => {
	const dir = mkdtempSync(join(tmpdir(), "nit-test-"))
	const socket = join(dir, "vscode.sock")
	// Stand in for the extension: instead of running the TUI, finish the review the way the script would.
	const server = createServer((connection) => {
		connection.once("data", (chunk) => {
			const { script, cwd } = JSON.parse(chunk.toString())
			assert.equal(cwd, process.cwd())
			writeFileSync(join(dirname(script), "review.md"), "## Fix these\n")
			writeFileSync(join(dirname(script), "done"), "0\n")
			connection.end()
		})
	})
	await new Promise<void>((resolve) => server.listen(socket, resolve))
	try {
		const { status, stdout } = await popup(socket, extra)
		assert.equal(status, 0)
		assert.equal(stdout, "## Fix these\n")
	} finally {
		server.close()
		rmSync(dir, { recursive: true, force: true })
	}
})

test("popup skips a stale VS Code socket", async () => {
	const { status, stdout } = await popup(join(tmpdir(), "nit-test-missing.sock"))
	assert.equal(status, 1)
	assert.match(stdout, /no herdr, tmux, VS Code or Hyprland/)
})
