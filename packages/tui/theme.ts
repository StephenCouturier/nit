import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { configDir } from "../core/config.ts"

/**
 * The slice of a theme the review UI needs. pi's Theme satisfies it structurally.
 * Standalone, the default is the terminal's own 16-color palette (so it follows
 * whatever terminal theme you use); config.json "theme" can point at a base16 scheme.
 */
export type ThemeColor =
	| "accent"
	| "borderMuted"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text"
	| "toolTitle"
	| "mdLink"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "toolDiffContext"

export interface ReviewTheme {
	fg(color: ThemeColor, text: string): string
	bold(text: string): string
}

const ANSI: Record<ThemeColor, string> = {
	accent: "36",
	borderMuted: "90",
	success: "32",
	error: "31",
	warning: "33",
	muted: "37",
	dim: "90",
	text: "39",
	toolTitle: "97",
	mdLink: "35",
	toolDiffAdded: "32",
	toolDiffRemoved: "31",
	toolDiffContext: "39",
}

export const ansiTheme: ReviewTheme = {
	fg: (color, text) => `\x1b[${ANSI[color]}m${text}\x1b[39m`,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
}

/**
 * Base16 roles → UI colors. Any scheme from tinted-theming/schemes (or base16
 * YAML/JSON in general) works: https://github.com/tinted-theming/schemes
 * Only foregrounds are themed; the terminal's own background is kept.
 */
const BASE16_ROLES: Record<ThemeColor, string> = {
	accent: "0D",
	borderMuted: "02",
	success: "0B",
	error: "08",
	warning: "0A",
	muted: "04",
	dim: "03",
	text: "05",
	toolTitle: "06",
	mdLink: "0E",
	toolDiffAdded: "0B",
	toolDiffRemoved: "08",
	toolDiffContext: "05",
}

/** Reads base00..base0F hex values from base16 YAML (classic or tinted `palette:` layout) or JSON. */
export function parseBase16(text: string): Record<string, string> {
	const palette: Record<string, string> = {}
	for (const match of text.matchAll(/"?base0([0-9A-Fa-f])"?\s*:\s*["']?#?([0-9A-Fa-f]{6})/g)) {
		palette[match[1]!.toUpperCase()] = match[2]!
	}
	const missing = Object.values(BASE16_ROLES).filter((slot) => !palette[slot.slice(1)])
	if (missing.length > 0) throw new Error(`not a base16 scheme (missing base${missing[0]})`)
	return palette
}

export function base16Theme(text: string): ReviewTheme {
	const palette = parseBase16(text)
	const sequence = (color: ThemeColor) => {
		const hex = palette[BASE16_ROLES[color].slice(1)]!
		const [r, g, b] = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))
		return `\x1b[38;2;${r};${g};${b}m`
	}
	return {
		fg: (color, text) => `${sequence(color)}${text}\x1b[39m`,
		bold: (text) => `\x1b[1m${text}\x1b[22m`,
	}
}

/** Theme from config.json: "terminal" (default) or a path to a base16 scheme, relative to the config dir. */
export function loadTheme(setting: string | undefined): ReviewTheme {
	if (!setting || setting === "terminal") return ansiTheme
	const expanded = setting.startsWith("~/") ? join(homedir(), setting.slice(2)) : setting
	const file = isAbsolute(expanded) ? expanded : join(configDir(), expanded)
	try {
		return base16Theme(readFileSync(file, "utf-8"))
	} catch (error) {
		throw new Error(`theme ${file}: ${(error as Error).message}`)
	}
}
