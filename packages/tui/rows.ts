import type { DiffLine, FileDiff } from "../core/diff.ts"
import { anchorLine, countChanges, fileDiffHash } from "../core/diff.ts"
import type { ReviewState, Thread } from "../core/threads.ts"
import { threadsEndingAt, threadsForFile } from "../core/threads.ts"

export type ViewState = "unviewed" | "viewed" | "changed"

export type Row =
	| {
			kind: "file"
			path: string
			file: FileDiff
			added: number
			removed: number
			threads: number
			view: ViewState
	  }
	| { kind: "hunk"; path: string; header: string }
	| { kind: "line"; path: string; line: DiffLine }
	/** Split view: a removed/old line beside an added/new line (either may be missing). */
	| { kind: "pair"; path: string; left?: DiffLine; right?: DiffLine }
	| { kind: "thread"; path: string; thread: Thread; messageIndex: number }
	| { kind: "spacer" }

export type LineRow = Extract<Row, { kind: "line" | "pair" }>

/** The diff line a row anchors comments to. In split view the new side wins. */
export function rowLine(row: Row): DiffLine | undefined {
	if (row.kind === "line") return row.line
	if (row.kind === "pair") return row.right ?? row.left
	return undefined
}

export function isLineRow(row: Row): row is LineRow {
	return row.kind === "line" || row.kind === "pair"
}

export function viewState(state: ReviewState, file: FileDiff): ViewState {
	const seen = state.viewed?.[file.path]
	if (!seen) return "unviewed"
	return seen === fileDiffHash(file) ? "viewed" : "changed"
}

/** Context lines pair with themselves; a run of removals pairs index-wise with the additions after it. */
function pairLines(lines: DiffLine[]): { left?: DiffLine; right?: DiffLine }[] {
	const pairs: { left?: DiffLine; right?: DiffLine }[] = []
	let index = 0
	while (index < lines.length) {
		const line = lines[index]!
		if (line.origin === "context") {
			pairs.push({ left: line, right: line })
			index++
			continue
		}
		const removed: DiffLine[] = []
		const added: DiffLine[] = []
		while (index < lines.length && lines[index]!.origin === "del") removed.push(lines[index++]!)
		while (index < lines.length && lines[index]!.origin === "add") added.push(lines[index++]!)
		for (let offset = 0; offset < Math.max(removed.length, added.length); offset++) {
			pairs.push({ left: removed[offset], right: added[offset] })
		}
	}
	return pairs
}

function threadRows(path: string, threads: Thread[]): Row[] {
	const rows: Row[] = []
	for (const thread of threads) {
		for (let index = 0; index < thread.messages.length; index++) {
			rows.push({ kind: "thread", path, thread, messageIndex: index })
		}
	}
	return rows
}

function inlineThreads(state: ReviewState, path: string, line: DiffLine | undefined): Thread[] {
	if (!line) return []
	const anchor = anchorLine(line)
	return threadsEndingAt(state, path, anchor.line, anchor.side).filter((thread) => thread.status !== "orphaned")
}

export function buildRows(files: FileDiff[], state: ReviewState, options: { split: boolean }): Row[] {
	const rows: Row[] = []

	for (const file of files) {
		const { added, removed } = countChanges(file)
		const view = viewState(state, file)
		rows.push({
			kind: "file",
			path: file.path,
			file,
			added,
			removed,
			threads: threadsForFile(state, file.path).length,
			view,
		})

		if (view === "viewed") {
			rows.push({ kind: "spacer" })
			continue
		}

		if (file.binary) {
			rows.push({ kind: "hunk", path: file.path, header: "binary file not shown" })
			rows.push({ kind: "spacer" })
			continue
		}

		for (const hunk of file.hunks) {
			rows.push({ kind: "hunk", path: file.path, header: hunk.header })
			if (options.split) {
				for (const pair of pairLines(hunk.lines)) {
					rows.push({ kind: "pair", path: file.path, ...pair })
					// A context pair is one line; otherwise each side can carry its own threads.
					const sides = pair.left === pair.right ? [pair.right] : [pair.left, pair.right]
					for (const line of sides) rows.push(...threadRows(file.path, inlineThreads(state, file.path, line)))
				}
			} else {
				for (const line of hunk.lines) {
					rows.push({ kind: "line", path: file.path, line })
					rows.push(...threadRows(file.path, inlineThreads(state, file.path, line)))
				}
			}
		}

		const orphaned = threadsForFile(state, file.path).filter((thread) => thread.status === "orphaned")
		rows.push(...threadRows(file.path, orphaned))
		rows.push({ kind: "spacer" })
	}

	return rows
}

export function isSelectable(row: Row): boolean {
	return row.kind === "file" || row.kind === "line" || row.kind === "pair" || row.kind === "thread"
}

export function nextSelectable(rows: Row[], from: number, direction: 1 | -1): number {
	let index = from + direction
	while (index >= 0 && index < rows.length) {
		if (isSelectable(rows[index]!)) return index
		index += direction
	}
	return from
}

export function nextHunk(rows: Row[], from: number, direction: 1 | -1): number {
	let index = from + direction
	while (index >= 0 && index < rows.length) {
		const row = rows[index]!
		if (row.kind === "hunk" || row.kind === "file") {
			const target = nextSelectable(rows, index, 1)
			// Going back, the header of the hunk we're in leads to where we already are (or below); keep looking.
			if (direction === 1 || target < from) return target
		}
		index += direction
	}
	return from
}
