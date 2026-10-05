import type { KeyId } from "@earendil-works/pi-tui"
import { matchesKey } from "@earendil-works/pi-tui"

/**
 * Every browse-mode action and its default keys. Users override any of them in
 * config.json under "keys", e.g. { "send": "ctrl+s", "down": ["j", "down"] }.
 * Key ids follow pi-tui: "j", "G", "ctrl+d", "tab", "shift+tab", "space", "pageDown", ...
 */
export const DEFAULT_KEYS = {
	down: ["j", "down"],
	up: ["k", "up"],
	left: ["h", "left"],
	right: ["l", "right"],
	nextHunk: ["n", "]"],
	prevHunk: ["p", "["],
	top: ["g", "home"],
	bottom: ["G", "end"],
	pageDown: ["ctrl+d", "pageDown"],
	pageUp: ["ctrl+u", "pageUp"],
	viewed: ["space"],
	range: ["v"],
	comment: ["c"],
	reply: ["r"],
	toggleType: ["tab"],
	resolve: ["x"],
	delete: ["d"],
	send: ["F"],
	split: ["\\"],
	lineNumbers: ["#"],
	search: ["/"],
	searchBack: ["?"],
	/** While a search is active these win over any other action bound to the same key (n is also next hunk). */
	searchNext: ["n"],
	searchPrev: ["N"],
	quit: ["q", "esc", "ctrl+c"],
} satisfies Record<string, string[]>

export type Action = keyof typeof DEFAULT_KEYS
export type KeyMap = Record<Action, string[]>

export function resolveKeys(overrides: Record<string, string | string[]> = {}): KeyMap {
	const keys = structuredClone(DEFAULT_KEYS) as KeyMap
	for (const [action, value] of Object.entries(overrides)) {
		if (!(action in keys)) throw new Error(`unknown key action "${action}" (valid: ${Object.keys(keys).join(", ")})`)
		keys[action as Action] = Array.isArray(value) ? value : [value]
	}
	return keys
}

/** Single printable characters match literally ("G", "#"); everything else goes through pi-tui ("ctrl+d", "tab"). */
export function matchesBinding(data: string, binding: string): boolean {
	if ([...binding].length === 1) {
		if (data === binding) return true
		if (binding >= "A" && binding <= "Z") return matchesKey(data, `shift+${binding.toLowerCase()}` as KeyId)
		return false
	}
	return matchesKey(data, binding as KeyId)
}

export function actionFor(keys: KeyMap, data: string): Action | undefined {
	for (const [action, bindings] of Object.entries(keys) as [Action, string[]][]) {
		if (bindings.some((binding) => matchesBinding(data, binding))) return action
	}
	return undefined
}

/** First binding of an action, for the help bar. */
export function keyLabel(keys: KeyMap, action: Action): string {
	return keys[action][0] ?? "?"
}
