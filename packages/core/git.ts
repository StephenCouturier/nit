export interface ExecResultLike {
	stdout: string
	stderr: string
	code: number
}

export type Exec = (command: string, args: string[]) => Promise<ExecResultLike>

export type ReviewScope = "branch" | "local"

export interface RepoBasics {
	root: string
	branch: string
}

export interface RepoInfo extends RepoBasics {
	baseRef: string
	diffBase: string
	scope: ReviewScope
}

export interface ChangedFile {
	path: string
	oldPath?: string
	status: "added" | "modified" | "deleted" | "renamed" | "untracked"
	binary: boolean
}

const BASE_CANDIDATES = ["main", "master", "develop"]

async function run(exec: Exec, args: string[]): Promise<string | null> {
	const result = await exec("git", args)
	if (result.code !== 0) return null
	return result.stdout.trim()
}

async function refExists(exec: Exec, ref: string): Promise<boolean> {
	const result = await exec("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
	return result.code === 0
}

export async function detectBaseRef(exec: Exec, override?: string): Promise<string | null> {
	if (override) {
		return (await refExists(exec, override)) ? override : null
	}

	const originHead = await run(exec, ["rev-parse", "--abbrev-ref", "origin/HEAD"])
	if (originHead && originHead !== "origin/HEAD" && (await refExists(exec, originHead))) {
		return originHead
	}

	for (const candidate of BASE_CANDIDATES) {
		const remote = `origin/${candidate}`
		if (await refExists(exec, remote)) return remote
	}
	for (const candidate of BASE_CANDIDATES) {
		if (await refExists(exec, candidate)) return candidate
	}
	return null
}

export async function getRepoBasics(exec: Exec): Promise<RepoBasics> {
	const root = await run(exec, ["rev-parse", "--show-toplevel"])
	if (!root) throw new Error("not inside a git repository")
	const branch = (await run(exec, ["rev-parse", "--abbrev-ref", "HEAD"])) ?? "HEAD"
	return { root, branch }
}

export async function getRepoInfo(
	exec: Exec,
	options: { scope?: ReviewScope; baseOverride?: string } = {},
): Promise<RepoInfo> {
	const scope = options.scope ?? "branch"
	const { root, branch } = await getRepoBasics(exec)

	if (scope === "local") {
		return { root, branch, baseRef: "HEAD", diffBase: "HEAD", scope }
	}

	const baseOverride = options.baseOverride
	const baseRef = await detectBaseRef(exec, baseOverride)
	if (!baseRef) {
		throw new Error(
			baseOverride
				? `base ref not found: ${baseOverride}`
				: "could not determine a base branch (tried origin/HEAD, origin/main, main, master)",
		)
	}

	const mergeBase = await run(exec, ["merge-base", baseRef, "HEAD"])
	if (!mergeBase) throw new Error(`no merge base between ${baseRef} and HEAD`)

	return { root, branch, baseRef, diffBase: mergeBase, scope }
}

function parseStatusChar(raw: string): ChangedFile["status"] {
	const char = raw[0]
	if (char === "A") return "added"
	if (char === "D") return "deleted"
	if (char === "R") return "renamed"
	return "modified"
}

export async function listChangedFiles(exec: Exec, diffBase: string): Promise<ChangedFile[]> {
	const files: ChangedFile[] = []

	const tracked = await run(exec, ["diff", "--name-status", "-M", diffBase])
	if (tracked) {
		for (const line of tracked.split("\n")) {
			if (!line.trim()) continue
			const parts = line.split("\t")
			const rawStatus = parts[0] ?? ""
			const status = parseStatusChar(rawStatus)
			if (status === "renamed" && parts.length >= 3) {
				files.push({ path: parts[2]!, oldPath: parts[1], status, binary: false })
			} else if (parts.length >= 2) {
				files.push({ path: parts[1]!, status, binary: false })
			}
		}
	}

	const untracked = await run(exec, ["ls-files", "--others", "--exclude-standard"])
	if (untracked) {
		for (const line of untracked.split("\n")) {
			if (!line.trim()) continue
			files.push({ path: line, status: "untracked", binary: false })
		}
	}

	files.sort((a, b) => a.path.localeCompare(b.path))
	return files
}

export async function getFileDiff(
	exec: Exec,
	diffBase: string,
	file: ChangedFile,
	contextLines = 5,
): Promise<string> {
	if (file.status === "untracked") {
		const result = await exec("git", [
			"diff",
			"--no-index",
			`-U${contextLines}`,
			"--",
			"/dev/null",
			file.path,
		])
		return result.stdout
	}

	const result = await exec("git", [
		"diff",
		"-M",
		`-U${contextLines}`,
		diffBase,
		"--",
		...(file.oldPath ? [file.oldPath, file.path] : [file.path]),
	])
	return result.stdout
}

export async function readFileLines(
	exec: Exec,
	revision: string | null,
	path: string,
): Promise<string[] | null> {
	if (revision === null) return null
	const content = await run(exec, ["show", `${revision}:${path}`])
	if (content === null) return null
	return content.split("\n")
}
