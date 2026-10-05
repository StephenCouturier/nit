import { createHash } from "node:crypto"

export type LineOrigin = "context" | "add" | "del"

export interface DiffLine {
	origin: LineOrigin
	oldNo: number | null
	newNo: number | null
	text: string
}

export interface Hunk {
	header: string
	oldStart: number
	oldCount: number
	newStart: number
	newCount: number
	lines: DiffLine[]
}

export interface FileDiff {
	path: string
	oldPath?: string
	hunks: Hunk[]
	binary: boolean
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

export function parseUnifiedDiff(raw: string, path: string, oldPath?: string): FileDiff {
	const file: FileDiff = { path, oldPath, hunks: [], binary: false }
	if (!raw.trim()) return file

	let current: Hunk | null = null
	let oldNo = 0
	let newNo = 0

	// Drop the final newline so it doesn't parse as a phantom empty context line.
	for (const line of raw.replace(/\n$/, "").split("\n")) {
		if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
			file.binary = true
			return file
		}

		const match = HUNK_HEADER.exec(line)
		if (match) {
			oldNo = Number.parseInt(match[1]!, 10)
			newNo = Number.parseInt(match[3]!, 10)
			current = {
				header: line,
				oldStart: oldNo,
				oldCount: match[2] ? Number.parseInt(match[2], 10) : 1,
				newStart: newNo,
				newCount: match[4] ? Number.parseInt(match[4], 10) : 1,
				lines: [],
			}
			file.hunks.push(current)
			continue
		}

		if (!current) continue
		if (line.startsWith("\\")) continue

		const marker = line[0]
		const text = line.slice(1)

		if (marker === "+") {
			current.lines.push({ origin: "add", oldNo: null, newNo, text })
			newNo++
		} else if (marker === "-") {
			current.lines.push({ origin: "del", oldNo, newNo: null, text })
			oldNo++
		} else if (marker === " " || line === "") {
			current.lines.push({ origin: "context", oldNo, newNo, text })
			oldNo++
			newNo++
		}
	}

	return file
}

export function anchorLine(line: DiffLine): { line: number; side: "new" | "old" } {
	if (line.origin === "del") return { line: line.oldNo ?? 0, side: "old" }
	return { line: line.newNo ?? 0, side: "new" }
}

export function countChanges(file: FileDiff): { added: number; removed: number } {
	let added = 0
	let removed = 0
	for (const hunk of file.hunks) {
		for (const line of hunk.lines) {
			if (line.origin === "add") added++
			else if (line.origin === "del") removed++
		}
	}
	return { added, removed }
}

export function findLineText(
	file: FileDiff,
	lineNo: number,
	side: "new" | "old",
): string | undefined {
	for (const hunk of file.hunks) {
		for (const line of hunk.lines) {
			const no = side === "new" ? line.newNo : line.oldNo
			if (no === lineNo) return line.text
		}
	}
	return undefined
}

/** Stable fingerprint of a file's diff, used to notice when a "viewed" file changed. */
export function fileDiffHash(file: FileDiff): string {
	const hash = createHash("sha1")
	hash.update(`${file.oldPath ?? ""}\0${file.path}\0${file.binary}\0`)
	for (const hunk of file.hunks) {
		for (const line of hunk.lines) hash.update(`${line.origin[0]}${line.text}\n`)
	}
	return hash.digest("hex").slice(0, 16)
}
