import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const CLI = fileURLToPath(new URL("./nit.ts", import.meta.url))

function popup(socket: string, extra: NodeJS.ProcessEnv = {}): Promise<{ status: number | null; stdout: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, NIT_VSCODE_SOCKET: socket }
  for (const key of ["HERDR_PANE_ID", "TMUX", "HYPRLAND_INSTANCE_SIGNATURE", "KITTY_WINDOW_ID", "KITTY_LISTEN_ON", "NIT_VSCODE_AGENT", "TERM_PROGRAM"]) delete env[key]
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
  assert.match(stdout, /no herdr, tmux, kitty, VS Code or Hyprland/)
})

function fakeCommand(dir: string, name: string, body: string): string {
  const bin = join(dir, "bin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(bin, name), 0o755)
  return `${bin}:${process.env.PATH}`
}

const fakeKitten = (dir: string, body: string) => fakeCommand(dir, "kitten", body)

const KITTY_ENV = { KITTY_WINDOW_ID: "7", KITTY_LISTEN_ON: "unix:/tmp/nit-test-kitty" }

test("popup opens a kitty overlay on the agent's window and prints its review", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nit-test-"))
  const log = join(dir, "args.log")
  const path = fakeKitten(
    dir,
    [
      `echo "$@" >> ${log}`,
      'case "$4" in',
      "  launch)",
      '    for arg in "$@"; do script="$arg"; done',
      '    echo "## Fix these" > "$(dirname "$script")/review.md"',
      '    echo 0 > "$(dirname "$script")/done"',
      "    echo 42 ;;",
      "esac",
    ].join("\n"),
  )
  try {
    const { status, stdout } = await popup(join(tmpdir(), "nit-test-missing.sock"), { ...KITTY_ENV, PATH: path })
    assert.equal(status, 0)
    assert.equal(stdout, "## Fix these\n")
    const [launch] = readFileSync(log, "utf-8").split("\n")
    assert.match(launch, /^@ --to unix:\/tmp\/nit-test-kitty launch --type=overlay --match window_id:7 --cwd .+ sh .+run\.sh$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("popup reports a failing kitty launch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nit-test-"))
  const path = fakeKitten(dir, 'echo "remote control is disabled" >&2; echo "remote control is disabled"; exit 1')
  try {
    const { status, stdout } = await popup(join(tmpdir(), "nit-test-missing.sock"), { ...KITTY_ENV, PATH: path })
    assert.equal(status, 1)
    assert.match(stdout, /kitty: kitten @ launch failed: remote control is disabled/)
    assert.match(stdout, /allow_remote_control and listen_on/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("popup prefers tmux over a kitty it was launched from", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nit-test-"))
  const marker = join(dir, "kitten-called")
  fakeKitten(dir, `touch ${marker}`)
  const path = fakeCommand(
    dir,
    "tmux",
    [
      'for arg in "$@"; do command="$arg"; done',
      `script=$(echo "$command" | sed "s/^sh '//; s/'$//")`,
      'echo "## From tmux" > "$(dirname "$script")/review.md"',
      'echo 0 > "$(dirname "$script")/done"',
    ].join("\n"),
  )
  try {
    const { stdout } = await popup(join(tmpdir(), "nit-test-missing.sock"), { ...KITTY_ENV, TMUX: "/tmp/tmux,1,0", PATH: path })
    assert.equal(stdout, "## From tmux\n")
    assert.equal(existsSync(marker), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
