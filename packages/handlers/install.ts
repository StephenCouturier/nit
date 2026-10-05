import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * `nit install <agent>`: wire a `/nit` command into an agent so a review can be started
 * from inside it. Command agents get a markdown command (a skill, for Codex) from integrations/<agent>/
 * that runs `nit popup`; pi gets this package as an extension. The templates are usable
 * as-is (symlink them if you like) when `nit` is on PATH.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url))

export interface InstallOptions {
	/** Install into the current repo instead of the user's global config. */
	project: boolean
	/** Replace an existing command file that differs. */
	force: boolean
	cwd: string
	/** How the installed command calls nit (see nitCommand). */
	nit: string
}

type Installer = (options: InstallOptions) => string[]

function configHome(): string {
	return process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
}

function quote(value: string): string {
	return /^[\w./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

function writeCommand(agent: string, target: string, options: InstallOptions, template = "nit.md"): string[] {
	const text = readFileSync(join(ROOT, "integrations", agent, template), "utf-8").replace(
		/\bnit (popup|reply)\b/g,
		`${options.nit} $1`,
	)
	if (existsSync(target)) {
		const current = readFileSync(target, "utf-8")
		if (current === text) return [`${target} is already up to date`]
		if (!options.force) throw new Error(`${target} exists and differs; rerun with --force to replace it`)
	}
	// Never write through a symlink: it may point at this repo's own template.
	if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(target)
	mkdirSync(dirname(target), { recursive: true })
	writeFileSync(target, text)
	return [`wrote ${target}`]
}

function mcpHint(command: string, options: InstallOptions): string {
	return `optional: per-thread replies over MCP instead of the CLI: ${command} -- ${quote(options.nit)} mcp`
}

const INSTALLERS: Record<string, Installer> = {
	claude: (options) => {
		const dir = options.project ? join(options.cwd, ".claude") : join(homedir(), ".claude")
		return [
			...writeCommand("claude", join(dir, "commands", "nit.md"), options),
			"run /nit in Claude Code",
			mcpHint("claude mcp add nit", options),
		]
	},
	opencode: (options) => {
		const dir = options.project ? join(options.cwd, ".opencode") : join(configHome(), "opencode")
		return [...writeCommand("opencode", join(dir, "command", "nit.md"), options), "run /nit in opencode"]
	},
	// Codex dropped custom prompts ($CODEX_HOME/prompts) for skills, invoked as `$nit`.
	codex: (options) => {
		const dir = options.project ? join(options.cwd, ".agents") : process.env.CODEX_HOME || join(homedir(), ".codex")
		return [
			...writeCommand("codex", join(dir, "skills", "nit", "SKILL.md"), options, "SKILL.md"),
			"run $nit in Codex",
			mcpHint("codex mcp add nit", options),
		]
	},
	pi: (options) => {
		const args = ["install", ROOT, ...(options.project ? ["-l"] : [])]
		const result = spawnSync("pi", args, { cwd: options.cwd, stdio: "inherit" })
		if (result.error || result.status !== 0) throw new Error(`pi ${args.join(" ")} failed`)
		return ["run /nit in pi"]
	},
}

export const INSTALLABLE = Object.keys(INSTALLERS)

export function install(agent: string, options: InstallOptions): string[] {
	const installer = INSTALLERS[agent]
	if (!installer) throw new Error(`nothing to install for "${agent}" (installable: ${INSTALLABLE.join(", ")})`)
	return installer(options)
}
