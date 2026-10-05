import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ReviewBatch } from "../core/batch.ts"
import type { AgentMode, AgentSpec, Delivered, Handler } from "../core/handler.ts"
import { buildCompactPrompt } from "../core/render.ts"

export type { AgentMode, AgentSpec }

/** Linux caps a single argv string at 128 KiB; longer reviews are passed by reference instead. */
const MAX_ARG_BYTES = 100_000

export function commandExists(command: string): boolean {
	return spawnSync("sh", ["-c", 'command -v "$1"', "sh", command], { stdio: "ignore" }).status === 0
}

interface Invocation {
	command: string
	args: string[]
	stdin?: string
	cleanup: () => void
}

/**
 * Fill `{prompt}` / `{file}` in an argv. With neither, a headless run gets the review on
 * stdin and an interactive one gets it as the last argument (how most agent CLIs take one).
 */
function invocation(argv: string[], mode: AgentMode, prompt: string, batch: ReviewBatch, nit: string): Invocation {
	const usesPrompt = argv.some((arg) => arg.includes("{prompt}"))
	const usesFile = argv.some((arg) => arg.includes("{file}"))
	const viaArg = usesPrompt || (!usesFile && mode !== "headless")

	if (viaArg && Buffer.byteLength(prompt) > MAX_ARG_BYTES) {
		prompt = buildCompactPrompt(batch, batch.replyVia === "tool" ? "tool" : "cli", nit)
	}

	let dir: string | undefined
	let file = ""
	if (usesFile) {
		dir = mkdtempSync(join(tmpdir(), "nit-"))
		file = join(dir, "review.md")
		writeFileSync(file, `${prompt}\n`)
	}

	const filled = argv.map((arg) => arg.replaceAll("{prompt}", prompt).replaceAll("{file}", file))
	if (!usesPrompt && !usesFile && mode !== "headless") filled.push(prompt)
	const [command, ...args] = filled
	if (!command) throw new Error("empty agent command")

	return {
		command,
		args,
		stdin: !usesPrompt && !usesFile && mode === "headless" ? prompt : undefined,
		cleanup: () => {
			if (dir) rmSync(dir, { recursive: true, force: true })
		},
	}
}

function exitMessage(name: string, code: number | null, signal: NodeJS.Signals | null): string | undefined {
	if (signal) return `${name} was killed by ${signal}`
	return code ? `${name} exited with code ${code}` : undefined
}

/** The agent takes over the terminal; nit waits for it to exit. */
function runInteractive(run: Invocation, cwd: string, name: string): Promise<Delivered> {
	// Ctrl+C belongs to the agent (it interrupts a turn); without this nit would die and orphan it.
	const ignore = () => {}
	process.on("SIGINT", ignore)
	return new Promise<Delivered>((resolve, reject) => {
		const child = spawn(run.command, run.args, { cwd, stdio: "inherit" })
		child.on("error", reject)
		child.on("close", (code, signal) => resolve({ finished: true, message: exitMessage(name, code, signal) }))
	}).finally(() => process.off("SIGINT", ignore))
}

/** Stream the agent's output through and keep it, so its numbered sections can settle the batch. */
function runHeadless(run: Invocation, cwd: string, name: string): Promise<Delivered> {
	return new Promise((resolve, reject) => {
		const child = spawn(run.command, run.args, {
			cwd,
			stdio: [run.stdin === undefined ? "ignore" : "pipe", "pipe", "inherit"],
		})
		const chunks: Buffer[] = []
		child.stdout!.on("data", (chunk: Buffer) => {
			chunks.push(chunk)
			process.stdout.write(chunk)
		})
		child.on("error", reject)
		child.on("close", (code, signal) =>
			resolve({
				finished: true,
				finalText: Buffer.concat(chunks).toString("utf-8"),
				message: exitMessage(name, code, signal),
			}),
		)
		if (run.stdin !== undefined) child.stdin!.end(run.stdin)
	})
}

export function agentHandler(name: string, spec: AgentSpec, mode: AgentMode, nit: string): Handler {
	const argv = spec[mode]
	return {
		name: mode === "start" ? name : `${name}:${mode}`,
		description: spec.description ?? name,
		// Interactive agents report per thread; headless output is parsed once the run ends.
		replyVia: mode === "headless" ? "sections" : "cli",
		sendLabel: `send to ${name}`,
		preflight() {
			if (!argv?.length) throw new Error(`handler ${name} has no "${mode}" command`)
			if (!commandExists(argv[0]!)) throw new Error(`${argv[0]} not found on PATH (needed by handler ${name})`)
		},
		async deliver({ prompt, batch, cwd }) {
			if (!argv?.length) throw new Error(`handler ${name} has no "${mode}" command`)
			const run = invocation(argv, mode, prompt, batch, nit)
			try {
				return mode === "headless" ? await runHeadless(run, cwd, name) : await runInteractive(run, cwd, name)
			} finally {
				run.cleanup()
			}
		},
	}
}
