import { spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Config } from "../core/config.ts"
import type { AgentMode, AgentSpec, Handler } from "../core/handler.ts"
import { AGENT_MODES } from "../core/handler.ts"
import { agentHandler, commandExists } from "./agent.ts"
import { clipboard, file, stdout } from "./pipe.ts"

/** The agents nit knows out of the box. config.json "handlers" can override any field or add more. */
export const BUILTIN_AGENTS: Record<string, AgentSpec> = {
	claude: {
		description: "Claude Code",
		start: ["claude", "{prompt}"],
		continue: ["claude", "--continue", "{prompt}"],
		headless: ["claude", "-p"],
	},
	codex: {
		description: "OpenAI Codex CLI",
		start: ["codex", "{prompt}"],
		continue: ["codex", "resume", "--last", "{prompt}"],
		headless: ["codex", "exec", "-"],
	},
	opencode: {
		description: "opencode",
		start: ["opencode", "--prompt", "{prompt}"],
		continue: ["opencode", "--continue", "--prompt", "{prompt}"],
		headless: ["opencode", "run", "{prompt}"],
	},
	pi: {
		description: "pi (inside pi, the /nit extension sends to the running session instead)",
		start: ["pi", "{prompt}"],
		continue: ["pi", "--continue", "{prompt}"],
		headless: ["pi", "-p", "{prompt}"],
	},
}

const PIPES: Record<string, Handler> = { stdout, clipboard }

export function agentSpecs(config: Config = {}): Record<string, AgentSpec> {
	const specs: Record<string, AgentSpec> = structuredClone(BUILTIN_AGENTS)
	for (const [name, spec] of Object.entries(config.handlers ?? {})) {
		if (name in PIPES || name === "file") throw new Error(`"${name}" is a built-in handler and can't be redefined`)
		specs[name] = { ...specs[name], ...spec }
	}
	return specs
}

const BIN = fileURLToPath(new URL("../../bin/nit", import.meta.url))

/**
 * How an agent should call nit back (`nit reply`, `nit popup`): plain `nit` when that's
 * this install on PATH, otherwise this install's launcher by absolute path.
 */
export function nitCommand(): string {
	const found = spawnSync("sh", ["-c", "command -v nit"], { encoding: "utf-8" })
	try {
		if (found.status === 0 && realpathSync(found.stdout.trim()) === realpathSync(BIN)) return "nit"
	} catch {
		// A dangling `nit` on PATH isn't this install.
	}
	return BIN
}

export interface ResolveOptions {
	mode?: AgentMode
	/** Path for the file handler. */
	out?: string
	config?: Config
}

/** `name` is a handler name, optionally with a mode suffix: `claude`, `claude:continue`, `codex:headless`. */
export function resolveHandler(name: string, options: ResolveOptions = {}): Handler {
	const [base = "", suffix] = name.split(":")
	if (base === "file") {
		if (!options.out) throw new Error("the file handler needs --out <path>")
		return file(options.out)
	}
	const pipe = PIPES[base]
	if (pipe) return pipe

	const spec = agentSpecs(options.config)[base]
	if (!spec) throw new Error(`unknown handler "${base}" (available: ${handlerNames(options.config).join(", ")})`)
	const mode = (suffix ?? options.mode ?? "start") as AgentMode
	if (!AGENT_MODES.includes(mode)) throw new Error(`unknown mode "${mode}" (${AGENT_MODES.join(", ")})`)
	return agentHandler(base, spec, mode, nitCommand())
}

export function handlerNames(config?: Config): string[] {
	return [...Object.keys(PIPES), "file", ...Object.keys(agentSpecs(config))]
}

export interface HandlerInfo {
	name: string
	description: string
	modes: AgentMode[]
	available: boolean
}

export function listHandlers(config?: Config): HandlerInfo[] {
	const pipes = [stdout, clipboard, file("")].map((handler) => ({
		name: handler.name,
		description: handler.description,
		modes: [],
		available: true,
	}))
	const agents = Object.entries(agentSpecs(config)).map(([name, spec]) => {
		const modes = AGENT_MODES.filter((mode) => spec[mode]?.length)
		const command = modes.map((mode) => spec[mode]![0]!)[0]
		return { name, description: spec.description ?? name, modes, available: !!command && commandExists(command) }
	})
	return [...pipes, ...agents]
}
