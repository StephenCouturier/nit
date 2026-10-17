"use strict"
const fs = require("node:fs")
const net = require("node:net")
const os = require("node:os")
const path = require("node:path")
const vscode = require("vscode")

/**
 * The VS Code side of `nit popup`. Each window listens on a socket and advertises it as
 * NIT_VSCODE_SOCKET, both in the extension host's own environment (inherited by agents
 * that extensions spawn, like Claude Code's panel) and in integrated terminals (opencode's
 * extension, or an agent run by hand). `nit popup` connects and sends one JSON line,
 * {"script", "cwd"}; we run the script in an editor-area terminal and close the
 * connection when that terminal closes, which is how nit knows the window is gone.
 *
 * NIT_VSCODE_AGENT is set only in the extension host, so it marks agents that extensions
 * spawned. Those run in no terminal, so any herdr/tmux variables they have were inherited
 * from wherever VS Code was launched, and nit should open the tab here instead.
 */

function activate(context) {
  const socket = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), `nit-vscode-${process.pid}.sock`)
  fs.rmSync(socket, { force: true })

  const server = net.createServer((connection) => {
    let buffer = ""
    connection.setEncoding("utf8")
    connection.on("error", () => { })
    const onData = (chunk) => {
      buffer += chunk
      const end = buffer.indexOf("\n")
      if (end < 0) return
      connection.off("data", onData)
      try {
        open(JSON.parse(buffer.slice(0, end)), connection)
      } catch (error) {
        connection.end(`${error.message}\n`)
      }
    }
    connection.on("data", onData)
  })
  server.on("error", (error) => vscode.window.showErrorMessage(`nit: cannot listen on ${socket}: ${error.message}`))
  server.listen(socket)

  process.env.NIT_VSCODE_SOCKET = socket
  process.env.NIT_VSCODE_AGENT = "1"
  context.environmentVariableCollection.persistent = false
  context.environmentVariableCollection.replace("NIT_VSCODE_SOCKET", socket)
  context.subscriptions.push({
    dispose() {
      server.close()
      fs.rmSync(socket, { force: true })
      if (process.env.NIT_VSCODE_SOCKET === socket) {
        delete process.env.NIT_VSCODE_SOCKET
        delete process.env.NIT_VSCODE_AGENT
      }
    },
  })
}

function open(request, connection) {
  if (typeof request.script !== "string") throw new Error("expected {\"script\": <path>}")
  const terminal = vscode.window.createTerminal({
    name: "nit",
    cwd: typeof request.cwd === "string" ? request.cwd : undefined,
    shellPath: "/bin/sh",
    shellArgs: [request.script],
    location: { viewColumn: vscode.ViewColumn.Active },
    isTransient: true,
  })
  terminal.show()
  const closed = vscode.window.onDidCloseTerminal((closing) => {
    if (closing === terminal) connection.end()
  })
  // nit gave up (timeout, killed): don't leave its review hanging around.
  connection.on("close", () => {
    closed.dispose()
    terminal.dispose()
  })
}

function deactivate() { }

module.exports = { activate, deactivate }
