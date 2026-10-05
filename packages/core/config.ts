import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { AgentSpec } from "./handler.ts"
import { adoptLegacyDir, dataDir, writeJsonAtomic } from "./store.ts"

/**
 * User configuration, read from ~/.config/nit/ (or $NIT_CONFIG_DIR):
 *
 *   config.json   { "theme": "terminal" | "<base16 scheme file>", "keys": { "<action>": "<key>" | ["<key>", ...] }, "context": 3,
 *                   "handler": "<default handler>", "handlers": { "<name>": <AgentSpec> } }
 *   header.md     replaces the opening line of the prompt
 *   footer.md     replaces the closing guidelines of the prompt
 *
 * Templates may use {count}, {fixes}, {questions}, {base} and {branch}.
 */
export interface Config {
	theme?: string
	keys?: Record<string, string | string[]>
	/** Diff lines of context shown around each comment in the prompt. */
	context?: number
	/** Where `nit` sends a review by default: stdout, clipboard, claude, codex, ... */
	handler?: string
	/** Extra CLI agents, or overrides of the built-in ones (see handler.ts). */
	handlers?: Record<string, AgentSpec>
}

export interface Templates {
	header?: string
	footer?: string
}

/** Per-user view state the TUI remembers between sessions. */
export interface UiPrefs {
	split?: boolean
	lineNumbers?: boolean
}

export function configDir(): string {
	if (process.env.NIT_CONFIG_DIR) return process.env.NIT_CONFIG_DIR
	const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
	return adoptLegacyDir(join(xdg, "nit"), join(xdg, "llm-review"))
}

function readText(file: string): string | undefined {
	try {
		return readFileSync(file, "utf-8")
	} catch {
		return undefined
	}
}

function readJson<T>(file: string): T | undefined {
	const text = readText(file)
	if (text === undefined) return undefined
	try {
		return JSON.parse(text) as T
	} catch (error) {
		throw new Error(`invalid JSON in ${file}: ${(error as Error).message}`)
	}
}

export function loadConfig(): Config {
	return readJson<Config>(join(configDir(), "config.json")) ?? {}
}

export function loadTemplates(): Templates {
	const header = readText(join(configDir(), "header.md"))?.trim()
	const footer = readText(join(configDir(), "footer.md"))?.trim()
	return { header: header || undefined, footer: footer || undefined }
}

export function fillTemplate(template: string, values: Record<string, string | number>): string {
	return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match))
}

function uiPrefsFile(): string {
	return join(dataDir(), "ui.json")
}

export function loadUiPrefs(): UiPrefs {
	try {
		return readJson<UiPrefs>(uiPrefsFile()) ?? {}
	} catch {
		return {}
	}
}

export async function saveUiPrefs(prefs: UiPrefs): Promise<void> {
	await writeJsonAtomic(uiPrefsFile(), prefs)
}
