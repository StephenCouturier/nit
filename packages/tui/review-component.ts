import type { Component, Focusable, TUI } from "@earendil-works/pi-tui"
import { Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import type { UiPrefs } from "../core/config.ts"
import type { DiffLine, FileDiff } from "../core/diff.ts"
import { anchorLine, fileDiffHash } from "../core/diff.ts"
import type { ReviewState, Thread, ThreadKind } from "../core/threads.ts"
import {
	addThread,
	isQuestion,
	KIND_LABEL,
	openThreads,
	removeThread,
	replyToThread,
	setStatus,
	threadLocation,
	toggleKind,
} from "../core/threads.ts"
import type { Action, KeyMap } from "./keys.ts"
import { actionFor, keyLabel, matchesBinding, resolveKeys } from "./keys.ts"
import type { LineRow, Row } from "./rows.ts"
import { buildRows, isLineRow, isSelectable, nextHunk, nextSelectable } from "./rows.ts"
import type { ReviewTheme, ThemeColor } from "./theme.ts"

export interface ReviewComponentOptions {
	tui: TUI
	theme: ReviewTheme
	files: FileDiff[]
	state: ReviewState
	onChange: (deletedId?: string) => void
	/** Called with every open thread when the user sends. */
	onSend: (threads: Thread[]) => void
	onClose: () => void
	/** Help-bar label for the send key, e.g. "send" inside an agent, "emit" for the standalone CLI. */
	sendLabel?: string
	/** Rows reserved for header/footer; the overlay inside pi needs more than a full-screen app. */
	chromeRows?: number
	keys?: KeyMap
	prefs?: UiPrefs
	onPrefsChange?: (prefs: UiPrefs) => void
}

type Mode = "browse" | "compose" | "search"
type Column = "left" | "right"

const MIN_VIEWPORT = 8
const CHROME_ROWS = 10
/** Below this width split view falls back to unified. */
const MIN_SPLIT_WIDTH = 100

/** Vim smartcase: case-insensitive unless the query has a capital. Invalid regexes match literally. */
function compileSearch(query: string): RegExp | null {
	if (!query) return null
	const flags = query === query.toLowerCase() ? "gi" : "g"
	try {
		return new RegExp(query, flags)
	} catch {
		return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags)
	}
}

function hasMatch(pattern: RegExp, text: string | undefined): boolean {
	if (!text) return false
	pattern.lastIndex = 0
	for (const match of text.matchAll(pattern)) if (match[0].length > 0) return true
	return false
}

export class ReviewComponent implements Component, Focusable {
	private isFocused = false

	get focused(): boolean {
		return this.isFocused
	}

	set focused(value: boolean) {
		this.isFocused = value
		if (this.input) this.input.focused = value
	}

	private readonly tui: TUI
	private readonly theme: ReviewTheme
	private files: FileDiff[]
	private readonly state: ReviewState
	private readonly onChange: (deletedId?: string) => void
	private readonly onSend: (threads: Thread[]) => void
	private readonly onClose: () => void
	private readonly onPrefsChange?: (prefs: UiPrefs) => void
	private readonly sendLabel: string
	private readonly chromeRows: number
	private readonly keys: KeyMap

	private rows: Row[] = []
	private cursor = 0
	private scrollTop = 0
	private mode: Mode = "browse"
	private input: Input | null = null
	private composeThread: Thread | null = null
	private composeKind: ThreadKind = "fix"
	private notice = ""
	/** Row index where a range selection started, or null. */
	private mark: number | null = null

	/** Last search, kept for n/N; highlighting is cleared with esc but the query survives, like vim's :noh. */
	private searchQuery = ""
	private searchPattern: RegExp | null = null
	private searchHighlight = false
	private searchDirection: 1 | -1 = 1
	/** Cursor/scroll/column when the search prompt opened, restored on esc. */
	private searchOrigin: { cursor: number; scrollTop: number; column: Column } | null = null

	private split: boolean
	private lineNumbers: boolean
	/** Split view only: which side comments attach to on rows that have both. */
	private column: Column = "right"
	/** Whether rows are currently built split (split preference AND wide enough). */
	private builtSplit = false
	private width = 0

	constructor(options: ReviewComponentOptions) {
		this.tui = options.tui
		this.theme = options.theme
		this.files = options.files
		this.state = options.state
		this.onChange = options.onChange
		this.onSend = options.onSend
		this.onClose = options.onClose
		this.onPrefsChange = options.onPrefsChange
		this.sendLabel = options.sendLabel ?? "send"
		this.chromeRows = options.chromeRows ?? CHROME_ROWS
		this.keys = options.keys ?? resolveKeys()
		this.split = options.prefs?.split ?? false
		this.lineNumbers = options.prefs?.lineNumbers ?? true
		this.rebuild()
		this.cursor = isSelectable(this.rows[0] ?? { kind: "spacer" }) ? 0 : nextSelectable(this.rows, 0, 1)
	}

	setFiles(files: FileDiff[]): void {
		this.files = files
		this.rebuild()
		this.clampCursor()
		this.tui.requestRender()
	}

	setNotice(text: string): void {
		this.notice = text
		this.tui.requestRender()
	}

	// ── rows & cursor ───────────────────────────────────────────────

	private wantsSplit(): boolean {
		return this.split && (this.width === 0 || this.width >= MIN_SPLIT_WIDTH)
	}

	private rebuild(): void {
		this.builtSplit = this.wantsSplit()
		this.rows = buildRows(this.files, this.state, { split: this.builtSplit })
	}

	/** Rebuild keeping the cursor on the same diff line / file where possible. */
	private rebuildKeepingPlace(): void {
		const row = this.currentRow()
		const line = row ? this.lineFor(row) : undefined
		const path = row && row.kind !== "spacer" ? row.path : undefined
		this.mark = null
		this.rebuild()
		let index = -1
		if (line) index = this.rows.findIndex((entry) => isLineRow(entry) && (entry.kind === "line" ? entry.line === line : entry.left === line || entry.right === line))
		if (index < 0 && path) index = this.rows.findIndex((entry) => entry.kind === "file" && entry.path === path)
		if (index >= 0) this.cursor = index
		this.clampCursor()
	}

	private clampCursor(): void {
		if (this.cursor >= this.rows.length) this.cursor = Math.max(0, this.rows.length - 1)
		if (this.rows.length > 0 && !isSelectable(this.rows[this.cursor]!)) {
			const forward = nextSelectable(this.rows, this.cursor, 1)
			this.cursor = forward === this.cursor ? nextSelectable(this.rows, this.cursor, -1) : forward
		}
	}

	private viewportHeight(): number {
		const rows = this.tui.terminal.rows || 24
		return Math.max(MIN_VIEWPORT, rows - this.chromeRows)
	}

	private ensureVisible(): void {
		const height = this.viewportHeight()
		if (this.cursor < this.scrollTop) this.scrollTop = this.cursor
		if (this.cursor >= this.scrollTop + height) this.scrollTop = this.cursor - height + 1
		const maxTop = Math.max(0, this.rows.length - height)
		if (this.scrollTop > maxTop) this.scrollTop = maxTop
		if (this.scrollTop < 0) this.scrollTop = 0
	}

	private currentRow(): Row | undefined {
		return this.rows[this.cursor]
	}

	private currentThread(): Thread | undefined {
		const row = this.currentRow()
		return row?.kind === "thread" ? row.thread : undefined
	}

	/** The diff line a row anchors to, honouring the active column in split view. */
	private lineFor(row: Row): DiffLine | undefined {
		if (row.kind === "line") return row.line
		if (row.kind !== "pair") return undefined
		return this.column === "left" ? (row.left ?? row.right) : (row.right ?? row.left)
	}

	// ── range selection ─────────────────────────────────────────────

	private markedRows(): LineRow[] {
		if (this.mark === null) return []
		const from = Math.min(this.mark, this.cursor)
		const to = Math.max(this.mark, this.cursor)
		return this.rows.slice(from, to + 1).filter(isLineRow)
	}

	private inMarkedRange(index: number): boolean {
		if (this.mark === null) return false
		return index >= Math.min(this.mark, this.cursor) && index <= Math.max(this.mark, this.cursor)
	}

	/**
	 * The range selection as a thread anchor. Ranges are numbered on the new side when
	 * any selected line exists there; removed lines inside such a range are just context.
	 */
	private selectedRange():
		| { path: string; line: number; endLine: number; side: "new" | "old"; anchorText: string }
		| undefined {
		const rows = this.markedRows()
		const path = rows[0]?.path
		if (!path || rows.some((row) => row.path !== path)) return undefined
		const lines = rows.map((row) => this.lineFor(row)).filter((line): line is DiffLine => line !== undefined)
		if (lines.length < 2) return undefined
		const onNew = lines.filter((line) => line.newNo !== null)
		const side: "new" | "old" = onNew.length > 0 ? "new" : "old"
		const anchored = side === "new" ? onNew : lines
		const numberOf = (line: DiffLine) => (side === "new" ? line.newNo : line.oldNo) ?? 0
		return {
			path,
			line: numberOf(anchored[0]!),
			endLine: numberOf(anchored[anchored.length - 1]!),
			side,
			anchorText: anchored[0]!.text,
		}
	}

	// ── search ──────────────────────────────────────────────────────

	/** Which side of a row matches, or null. Split rows report the side so the cursor can follow it. */
	private rowMatch(row: Row, pattern: RegExp): Column | "row" | null {
		if (row.kind === "file") return hasMatch(pattern, row.path) ? "row" : null
		if (row.kind === "line") return hasMatch(pattern, row.line.text) ? "row" : null
		if (row.kind === "pair") {
			const right = hasMatch(pattern, row.right?.text)
			const left = row.left !== row.right && hasMatch(pattern, row.left?.text)
			if (this.column === "left" && left) return "left"
			return right ? "right" : left ? "left" : null
		}
		if (row.kind === "thread") return hasMatch(pattern, row.thread.messages[row.messageIndex]?.text) ? "row" : null
		return null
	}

	private matchingRows(pattern: RegExp): number[] {
		const indices: number[] = []
		for (let index = 0; index < this.rows.length; index++) if (this.rowMatch(this.rows[index]!, pattern)) indices.push(index)
		return indices
	}

	/**
	 * Move to the next match strictly after (or before) `from`, wrapping around like vim.
	 * `inclusive` also accepts `from` itself, for incremental search as the query is typed.
	 */
	private jumpToMatch(pattern: RegExp, from: number, direction: 1 | -1, inclusive = false): boolean {
		const matches = this.matchingRows(pattern)
		if (matches.length === 0) {
			this.notice = `pattern not found: ${this.searchQuery}`
			return false
		}
		const ahead = direction === 1
			? matches.find((index) => (inclusive ? index >= from : index > from))
			: matches.findLast((index) => (inclusive ? index <= from : index < from))
		const target = ahead ?? (direction === 1 ? matches[0]! : matches[matches.length - 1]!)
		const side = this.rowMatch(this.rows[target]!, pattern)
		if (side === "left" || side === "right") this.column = side
		this.cursor = target
		const position = `${matches.indexOf(target) + 1}/${matches.length}`
		const prefix = direction === 1 ? "/" : "?"
		this.notice = ahead === undefined
			? `search hit ${direction === 1 ? "BOTTOM, continuing at TOP" : "TOP, continuing at BOTTOM"} · [${position}]`
			: `${prefix}${this.searchQuery} [${position}]`
		return true
	}

	private startSearch(direction: 1 | -1): void {
		this.searchDirection = direction
		this.searchOrigin = { cursor: this.cursor, scrollTop: this.scrollTop, column: this.column }
		this.mode = "search"
		const input = new Input()
		input.focused = this.isFocused
		input.onSubmit = (value) => this.submitSearch(value)
		input.onEscape = () => this.cancelSearch()
		this.input = input
	}

	/** Incremental search: preview the first match from where the prompt opened. */
	private previewSearch(): void {
		const origin = this.searchOrigin
		if (!origin || this.mode !== "search") return
		const query = this.input?.getValue() ?? ""
		this.cursor = origin.cursor
		this.scrollTop = origin.scrollTop
		this.column = origin.column
		this.notice = ""
		const pattern = compileSearch(query)
		if (!pattern) return
		const previous = this.searchQuery
		this.searchQuery = query
		if (!this.jumpToMatch(pattern, origin.cursor, this.searchDirection, true)) this.notice = ""
		this.searchQuery = previous
	}

	private submitSearch(value: string): void {
		const origin = this.searchOrigin
		this.mode = "browse"
		this.input = null
		this.searchOrigin = null
		// An empty query repeats the last search, as in vim.
		const query = value || this.searchQuery
		const pattern = compileSearch(query)
		if (!pattern || !origin) {
			this.tui.requestRender()
			return
		}
		this.searchQuery = query
		this.searchPattern = pattern
		this.searchHighlight = true
		this.cursor = origin.cursor
		if (!this.jumpToMatch(pattern, origin.cursor, this.searchDirection)) this.cursor = origin.cursor
		this.ensureVisible()
		this.tui.requestRender()
	}

	private cancelSearch(): void {
		const origin = this.searchOrigin
		if (origin) {
			this.cursor = origin.cursor
			this.scrollTop = origin.scrollTop
			this.column = origin.column
		}
		this.mode = "browse"
		this.input = null
		this.searchOrigin = null
		this.notice = ""
		this.tui.requestRender()
	}

	/** n repeats in the search's own direction, N reverses it. */
	private repeatSearch(reverse: boolean): void {
		if (!this.searchPattern) return
		this.searchHighlight = true
		const direction = (reverse ? -this.searchDirection : this.searchDirection) as 1 | -1
		this.jumpToMatch(this.searchPattern, this.cursor, direction)
	}

	/** Reverse-video the search matches inside already-plain text. */
	private highlight(text: string): string {
		const pattern = this.searchHighlight ? this.searchPattern : null
		if (!pattern) return text
		pattern.lastIndex = 0
		return text.replace(pattern, (match) => (match ? `\x1b[7m${match}\x1b[27m` : match))
	}

	// ── compose ─────────────────────────────────────────────────────

	private startCompose(thread: Thread | null): void {
		this.composeThread = thread
		this.composeKind = thread?.kind ?? "fix"
		this.mode = "compose"
		const input = new Input()
		input.focused = this.isFocused
		input.onSubmit = (value) => this.submitCompose(value)
		input.onEscape = () => this.cancelCompose()
		this.input = input
	}

	private cancelCompose(): void {
		this.mode = "browse"
		this.input = null
		this.composeThread = null
		this.tui.requestRender()
	}

	private submitCompose(value: string): void {
		const text = value.trim()
		if (!text) {
			this.cancelCompose()
			return
		}

		const reply = this.composeThread
		if (reply) {
			if (reply.kind !== this.composeKind) toggleKind(reply)
			replyToThread(reply, "user", text)
		} else {
			const row = this.currentRow()
			const range = this.selectedRange()
			const line = row ? this.lineFor(row) : undefined
			const single = this.markedRows()
			const only = single.length === 1 ? this.lineFor(single[0]!) : undefined
			if (range) {
				addThread(this.state, { ...range, kind: this.composeKind, text })
			} else if ((line || only) && row && row.kind !== "spacer") {
				const target = (only ?? line)!
				const anchor = anchorLine(target)
				addThread(this.state, {
					path: single[0]?.path ?? row.path,
					line: anchor.line,
					side: anchor.side,
					anchorText: target.text,
					kind: this.composeKind,
					text,
				})
			} else if (row?.kind === "file") {
				addThread(this.state, { path: row.path, line: 0, side: "new", anchorText: "", kind: this.composeKind, text })
			}
		}

		this.mode = "browse"
		this.input = null
		this.composeThread = null
		this.mark = null
		this.rebuild()
		this.clampCursor()
		this.onChange()
		this.tui.requestRender()
	}

	// ── input ───────────────────────────────────────────────────────

	handleInput(data: string): void {
		if (this.mode === "search") {
			this.input?.handleInput(data)
			this.previewSearch()
			this.ensureVisible()
			this.tui.requestRender()
			return
		}

		if (this.mode === "compose") {
			if (this.keys.toggleType.some((binding) => matchesBinding(data, binding))) {
				this.composeKind = this.composeKind === "fix" ? "question" : "fix"
			} else {
				this.input?.handleInput(data)
			}
			this.tui.requestRender()
			return
		}

		this.notice = ""
		const searching = this.searchPattern !== null && this.mark === null
		const bound = (name: Action) => this.keys[name].some((binding) => matchesBinding(data, binding))
		const action = searching && bound("searchNext") ? "searchNext" : searching && bound("searchPrev") ? "searchPrev" : actionFor(this.keys, data)

		if (action === "quit" && !matchesBinding(data, "q") && (this.mark !== null || this.searchHighlight)) {
			// esc clears a range first, then search highlighting, and only then closes.
			if (this.mark !== null) this.mark = null
			else this.searchHighlight = false
			this.tui.requestRender()
			return
		}
		if (action === "quit") {
			this.onClose()
			return
		}
		if (action) this.perform(action)

		this.ensureVisible()
		this.tui.requestRender()
	}

	private persistPrefs(): void {
		this.onPrefsChange?.({ split: this.split, lineNumbers: this.lineNumbers })
	}

	private perform(action: Exclude<Action, "quit">): void {
		switch (action) {
			case "down":
				this.cursor = nextSelectable(this.rows, this.cursor, 1)
				return
			case "up":
				this.cursor = nextSelectable(this.rows, this.cursor, -1)
				return
			case "left":
				this.column = "left"
				return
			case "right":
				this.column = "right"
				return
			case "nextHunk":
				this.cursor = nextHunk(this.rows, this.cursor, 1)
				return
			case "prevHunk":
				this.cursor = nextHunk(this.rows, this.cursor, -1)
				return
			case "top":
				this.cursor = isSelectable(this.rows[0] ?? { kind: "spacer" }) ? 0 : nextSelectable(this.rows, 0, 1)
				return
			case "bottom":
				this.cursor = nextSelectable(this.rows, this.rows.length, -1)
				return
			case "pageDown":
			case "pageUp": {
				const direction = action === "pageDown" ? 1 : -1
				for (let i = 0; i < this.viewportHeight(); i++) this.cursor = nextSelectable(this.rows, this.cursor, direction)
				return
			}
			case "viewed": {
				const row = this.currentRow()
				if (!row || row.kind === "spacer") return
				const file = this.files.find((entry) => entry.path === row.path)
				if (!file) return
				const viewed = (this.state.viewed ??= {})
				const hash = fileDiffHash(file)
				if (viewed[file.path] === hash) delete viewed[file.path]
				else viewed[file.path] = hash
				this.mark = null
				this.rebuild()
				const index = this.rows.findIndex((entry) => entry.kind === "file" && entry.path === file.path)
				if (index >= 0) this.cursor = index
				this.clampCursor()
				this.onChange()
				return
			}
			case "range": {
				const row = this.currentRow()
				if (this.mark !== null) this.mark = null
				else if (row && isLineRow(row)) this.mark = this.cursor
				else this.notice = "start a range on a diff line"
				return
			}
			case "comment": {
				const row = this.currentRow()
				if (this.mark !== null) {
					const rows = this.markedRows()
					if (rows.some((entry) => entry.path !== rows[0]!.path)) this.notice = "a range must stay within one file"
					else if (rows.length > 0) this.startCompose(null)
				} else if (row && (isLineRow(row) || row.kind === "file")) this.startCompose(null)
				else if (row?.kind === "thread") this.startCompose(row.thread)
				return
			}
			case "reply": {
				const thread = this.currentThread()
				if (thread) this.startCompose(thread)
				return
			}
			case "toggleType": {
				const thread = this.currentThread()
				if (!thread) return
				toggleKind(thread)
				this.onChange()
				return
			}
			case "resolve": {
				const thread = this.currentThread()
				if (!thread) return
				const done = isQuestion(thread) ? "answered" : "resolved"
				setStatus(thread, thread.status === done ? "open" : done)
				this.onChange()
				return
			}
			case "delete": {
				const thread = this.currentThread()
				if (!thread) return
				removeThread(this.state, thread.id)
				this.mark = null
				this.rebuild()
				this.clampCursor()
				this.onChange(thread.id)
				return
			}
			case "send": {
				const threads = openThreads(this.state)
				if (threads.length === 0) this.notice = "no open comments"
				else this.onSend(threads)
				return
			}
			case "split":
				this.split = !this.split
				if (this.split && this.width > 0 && this.width < MIN_SPLIT_WIDTH) {
					this.notice = `split view needs ${MIN_SPLIT_WIDTH}+ columns`
				}
				this.rebuildKeepingPlace()
				this.persistPrefs()
				return
			case "lineNumbers":
				this.lineNumbers = !this.lineNumbers
				this.persistPrefs()
				return
			case "search":
			case "searchBack":
				this.mark = null
				this.startSearch(action === "search" ? 1 : -1)
				return
			case "searchNext":
			case "searchPrev":
				this.repeatSearch(action === "searchPrev")
				return
		}
	}

	// ── rendering ───────────────────────────────────────────────────

	private kindColor(kind: ThreadKind): ThemeColor {
		return kind === "question" ? "mdLink" : "warning"
	}

	private statusBadge(thread: Thread): string {
		const map: Record<Thread["status"], [string, ThemeColor]> = {
			open: ["open", "warning"],
			fixing: ["fixing", "accent"],
			resolved: ["done", "success"],
			orphaned: ["moved", "error"],
			asking: ["asking", "accent"],
			answered: ["answered", "success"],
			wontfix: ["won't fix", "muted"],
			needs_info: ["needs info", "warning"],
			needs_review: ["check", "warning"],
		}
		const [label, color] = map[thread.status] ?? ["open", "warning"]
		return this.theme.fg(color, label)
	}

	private lineColor(line: DiffLine): ThemeColor {
		return line.origin === "add" ? "toolDiffAdded" : line.origin === "del" ? "toolDiffRemoved" : "toolDiffContext"
	}

	/** Number gutter (when enabled), sign and text for one side of a diff line. */
	private lineCell(line: DiffLine | undefined, no: number | null | undefined, width: number): string {
		const theme = this.theme
		const gutter = this.lineNumbers ? `${theme.fg("dim", String(no ?? "").padStart(4))} ` : ""
		if (!line) return truncateToWidth(gutter, width)
		const sign = line.origin === "add" ? "+" : line.origin === "del" ? "-" : " "
		const body = theme.fg(this.lineColor(line), `${sign} ${this.highlight(line.text.replace(/\t/g, "  "))}`)
		return truncateToWidth(`${gutter}${body}`, width)
	}

	private pad(text: string, width: number): string {
		return text + " ".repeat(Math.max(0, width - visibleWidth(text)))
	}

	private renderRow(row: Row, width: number, selected: boolean, marked: boolean): string[] {
		const theme = this.theme
		const marker = selected ? theme.fg("accent", "▌") : marked ? theme.fg("warning", "┃") : " "

		if (row.kind === "spacer") return [""]

		if (row.kind === "file") {
			const arrow = row.view === "viewed" ? "▸" : "▾"
			const stats = `${theme.fg("toolDiffAdded", `+${row.added}`)} ${theme.fg("toolDiffRemoved", `-${row.removed}`)}`
			const comments = row.threads > 0 ? theme.fg("warning", ` ${row.threads}◆`) : ""
			const view =
				row.view === "viewed"
					? theme.fg("success", "  ✓ viewed")
					: row.view === "changed"
						? theme.fg("warning", "  ● changed since viewed")
						: ""
			const label = theme.bold(theme.fg("toolTitle", this.highlight(row.path)))
			return [truncateToWidth(`${marker}${arrow} ${label} ${stats}${comments}${view}`, width)]
		}

		if (row.kind === "hunk") {
			return [truncateToWidth(`${marker}  ${theme.fg("dim", row.header)}`, width)]
		}

		if (row.kind === "line") {
			const line = row.line
			const no = line.origin === "del" ? line.oldNo : line.newNo
			return [truncateToWidth(`${marker}${this.lineCell(line, no, width - 1)}`, width)]
		}

		if (row.kind === "pair") {
			const half = Math.floor((width - 2) / 2)
			const left = this.pad(this.lineCell(row.left, row.left?.oldNo, half), half)
			const right = ` ${this.lineCell(row.right, row.right?.newNo, width - half - 3)}`
			const leftMark = selected && this.column === "left" ? theme.fg("accent", "▌") : marked ? theme.fg("warning", "┃") : " "
			const divider = selected && this.column === "right" ? theme.fg("accent", "▌") : theme.fg("borderMuted", "│")
			return [truncateToWidth(`${leftMark}${left}${divider}${right}`, width)]
		}

		const thread = row.thread
		const message = thread.messages[row.messageIndex]!
		const isFirst = row.messageIndex === 0
		const bar = theme.fg(this.kindColor(thread.kind), "┃")
		const indent = this.builtSplit && thread.side === "new" ? " ".repeat(Math.floor((width - 2) / 2) + 2) : "      "
		const prefix = `${marker}${indent}${bar} `

		const head = isFirst
			? `${theme.fg(this.kindColor(thread.kind), KIND_LABEL[thread.kind])} ${this.statusBadge(thread)} ${theme.fg("dim", threadLocation(thread))}`
			: theme.fg("dim", message.role === "user" ? "reviewer" : "agent")

		const lines = [truncateToWidth(`${prefix}${head}`, width)]
		for (const part of message.text.split("\n")) {
			lines.push(truncateToWidth(`${prefix}${theme.fg(message.role === "agent" ? "muted" : "text", this.highlight(part))}`, width))
		}
		return lines
	}

	private helpText(): string {
		const k = (action: Action) => keyLabel(this.keys, action)
		if (this.mark !== null) {
			return ` range: move to extend · ${k("comment")} comment on ${this.markedRows().length} line(s) · ${k("range")}/esc cancel`
		}
		const columns = this.builtSplit ? ` · ${k("left")}/${k("right")} side` : ""
		// With a search active, n/N belong to it, so show hunk keys that don't collide.
		const free = (action: Action) => (this.searchPattern ? this.keys[action].find((key) => !this.keys.searchNext.includes(key) && !this.keys.searchPrev.includes(key)) : undefined) ?? k(action)
		const match = this.searchPattern ? ` · ${k("searchNext")}/${k("searchPrev")} match` : ""
		const hunks = `${free("nextHunk")}/${free("prevHunk")} hunk${match}`
		return ` ${k("down")}/${k("up")} move · ${hunks}${columns} · ${k("search")} search · ${k("comment")} comment · ${k("range")} range · ${k("reply")} reply · ${k("toggleType")} fix/question · ${k("resolve")} done · ${k("delete")} del · ${k("viewed")} viewed · ${k("split")} split · ${k("lineNumbers")} line #s · ${k("send")} ${this.sendLabel} all · ${k("quit")} quit`
	}

	render(width: number): string[] {
		this.width = width
		if (this.wantsSplit() !== this.builtSplit) this.rebuildKeepingPlace()
		this.ensureVisible()
		const theme = this.theme
		const lines: string[] = []

		const counts = this.state.threads.reduce(
			(acc, thread) => {
				acc[thread.status] = (acc[thread.status] ?? 0) + 1
				return acc
			},
			{} as Record<string, number>,
		)
		const questions = this.state.threads.filter(isQuestion).length
		const viewed = this.rows.filter((row) => row.kind === "file" && row.view === "viewed").length

		const title = theme.bold(theme.fg("accent", " nit "))
		const done = (counts.resolved ?? 0) + (counts.answered ?? 0)
		const summary = theme.fg(
			"muted",
			`${this.state.branch} ← ${this.state.baseRef} · ${viewed}/${this.files.length} viewed · ${counts.open ?? 0} open · ${questions} question(s) · ${done} done`,
		)
		lines.push(truncateToWidth(`${title}${summary}`, width))
		lines.push(theme.fg("borderMuted", "─".repeat(Math.max(0, width))))

		const height = this.viewportHeight()
		let rendered = 0
		let index = this.scrollTop
		while (rendered < height && index < this.rows.length) {
			const row = this.rows[index]!
			for (const line of this.renderRow(row, width, index === this.cursor, this.inMarkedRange(index))) {
				if (rendered >= height) break
				lines.push(line)
				rendered++
			}
			index++
		}
		while (rendered < height) {
			lines.push("")
			rendered++
		}

		lines.push(theme.fg("borderMuted", "─".repeat(Math.max(0, width))))

		if (this.mode === "search" && this.input) {
			const prompt = this.searchDirection === 1 ? "/" : "?"
			lines.push(truncateToWidth(theme.fg("dim", ` search ${prompt} · regex, smartcase · enter jump · esc cancel`), width))
			for (const line of this.input.render(width)) lines.push(line)
			if (this.notice) lines.push(truncateToWidth(theme.fg("warning", ` ${this.notice}`), width))
			return lines
		}

		if (this.mode === "compose" && this.input) {
			const kind = theme.bold(theme.fg(this.kindColor(this.composeKind), KIND_LABEL[this.composeKind]))
			const what = this.composeThread ? "reply" : "comment"
			lines.push(
				truncateToWidth(
					` ${kind} ${theme.fg("dim", `${what} · ${keyLabel(this.keys, "toggleType")} switch to ${this.composeKind === "fix" ? "question" : "fix"} · enter submit · esc cancel`)}`,
					width,
				),
			)
			for (const line of this.input.render(width)) lines.push(line)
			return lines
		}

		lines.push(truncateToWidth(theme.fg("dim", this.helpText()), width))
		if (this.notice) lines.push(truncateToWidth(theme.fg("warning", ` ${this.notice}`), width))
		return lines
	}

	invalidate(): void {}
}
