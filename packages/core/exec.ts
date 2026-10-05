import { execFile } from "node:child_process"
import type { Exec } from "./git.ts"

/** Exec backed by child_process, for hosts that don't provide their own (CLI, MCP server). */
export function nodeExec(cwd: string, options: { timeout?: number; signal?: AbortSignal } = {}): Exec {
	return (command, args) =>
		new Promise((resolve) => {
			execFile(
				command,
				args,
				{ cwd, timeout: options.timeout ?? 30_000, signal: options.signal, maxBuffer: 64 * 1024 * 1024 },
				(error, stdout, stderr) => {
					const code = error ? (typeof error.code === "number" ? error.code : 1) : 0
					resolve({ stdout: String(stdout), stderr: String(stderr), code })
				},
			)
		})
}
