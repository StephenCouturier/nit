import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * `nit popup`: open the review TUI somewhere the user can interact with it
 * (a herdr pane, a tmux popup, a floating Hyprland terminal), block until they
 * finish, then print the review markdown. This lets non-interactive callers such
 * as Claude Code's `!` command expansion use the TUI.
 *
 * Every launcher runs the same script, which writes the review to a file and then
 * a sentinel. We wait on the sentinel rather than on the launcher process, because
 * most launchers return before the user is done (herdr, hyprctl, single-instance terminals).
 */

const CLI = fileURLToPath(new URL("./nit.ts", import.meta.url))
const FORWARDED_ENV = ["NIT_HOME", "XDG_DATA_HOME", "PATH", "HOME"]
const POLL_MS = 250

function quote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`
}

interface Session {
	dir: string
	script: string
	out: string
	done: string
}

function prepare(cwd: string, reviewArgs: string[]): Session {
	const dir = mkdtempSync(join(tmpdir(), "nit-"))
	const session = {
		dir,
		script: join(dir, "run.sh"),
		out: join(dir, "review.md"),
		done: join(dir, "done"),
	}
	const exports = FORWARDED_ENV.filter((key) => process.env[key] !== undefined).map(
		(key) => `export ${key}=${quote(process.env[key]!)}`,
	)
	const command = [process.execPath, CLI, "review", ...reviewArgs, "--out", session.out].map(quote).join(" ")
	writeFileSync(
		session.script,
		[
			"#!/bin/sh",
			...exports,
			`cd ${quote(cwd)} || { echo 1 > ${quote(session.done)}; exit 1; }`,
			command,
			`echo $? > ${quote(session.done)}`,
			"",
		].join("\n"),
		{ mode: 0o755 },
	)
	return session
}

/** Returns a liveness check for the launched UI, or null when this launcher isn't available. */
type Launcher = (session: Session, cwd: string) => (() => boolean) | null

const herdr: Launcher = (session, cwd) => {
	if (!process.env.HERDR_PANE_ID) return null
	const split = spawnSync("herdr", ["pane", "split", "--current", "--direction", "right", "--focus", "--cwd", cwd], {
		encoding: "utf-8",
	})
	const id = /"pane_id":"([^"]+)"/.exec(split.stdout ?? "")?.[1]
	if (split.status !== 0 || !id) return null
	spawnSync("herdr", ["pane", "zoom", id, "--on"])
	spawnSync("herdr", ["pane", "run", id, `sh ${quote(session.script)}; exit`])
	return () => spawnSync("herdr", ["pane", "get", id], { encoding: "utf-8" }).status === 0
}

const tmux: Launcher = (session, cwd) => {
	if (!process.env.TMUX) return null
	const child = spawn("tmux", ["display-popup", "-E", "-w", "95%", "-h", "95%", "-d", cwd, `sh ${quote(session.script)}`], {
		stdio: "ignore",
	})
	let alive = true
	child.on("exit", () => {
		alive = false
	})
	return () => alive
}

function which(command: string): boolean {
	return spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0
}

const hyprland: Launcher = (session) => {
	if (!process.env.HYPRLAND_INSTANCE_SIGNATURE) return null
	const run = `sh ${quote(session.script)}`
	const terminal = which("alacritty")
		? `alacritty --class nit -e ${run}`
		: which("xdg-terminal-exec")
			? `xdg-terminal-exec ${run}`
			: null
	if (!terminal) return null
	const result = spawnSync("hyprctl", ["dispatch", "exec", `[float; size 90% 90%; center] ${terminal}`], {
		encoding: "utf-8",
	})
	if (result.status !== 0) return null
	// The terminal isn't our child; we can only wait for the sentinel.
	return () => true
}

const LAUNCHERS: [string, Launcher][] = [
	["herdr", herdr],
	["tmux", tmux],
	["hyprland", hyprland],
]

async function waitFor(session: Session, alive: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	let lastLivenessCheck = 0
	while (Date.now() < deadline) {
		if (existsSync(session.done)) return true
		if (Date.now() - lastLivenessCheck > 2000) {
			lastLivenessCheck = Date.now()
			// Give a closing pane a moment to flush the sentinel before declaring it gone.
			if (!alive()) return existsSync(session.done)
		}
		await new Promise((resolve) => setTimeout(resolve, POLL_MS))
	}
	return false
}

export async function popup(reviewArgs: string[]): Promise<void> {
	const cwd = process.cwd()
	const session = prepare(cwd, reviewArgs)
	try {
		let alive: (() => boolean) | null = null
		for (const [, launch] of LAUNCHERS) {
			alive = launch(session, cwd)
			if (alive) break
		}
		if (!alive) {
			process.stdout.write(
				"nit could not open a review window here (no herdr, tmux or Hyprland detected).\n" +
					"Run `nit --copy` in another terminal and paste the result instead.\n",
			)
			process.exitCode = 1
			return
		}

		const timeoutMs = Number(process.env.NIT_POPUP_TIMEOUT ?? 3600) * 1000
		const finished = await waitFor(session, alive, timeoutMs)
		const review = finished && existsSync(session.out) ? readFileSync(session.out, "utf-8").trim() : ""
		process.stdout.write(review ? `${review}\n` : "Review cancelled: no comments were sent.\n")
	} finally {
		rmSync(session.dir, { recursive: true, force: true })
	}
}
