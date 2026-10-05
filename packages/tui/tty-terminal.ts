import { openSync } from "node:fs"
import { ReadStream, WriteStream } from "node:tty"
import type { Terminal } from "@earendil-works/pi-tui"
import { StdinBuffer } from "@earendil-works/pi-tui"

/**
 * A pi-tui Terminal on /dev/tty instead of process.stdin/stdout, so the UI keeps
 * working while stdout is piped (`nit | claude -p`), the way fzf does.
 * Uses the alternate screen and restores the shell's screen on stop.
 */
export class TtyTerminal implements Terminal {
	private readonly input: ReadStream
	private readonly output: WriteStream
	private buffer?: StdinBuffer
	private onData?: (data: string) => void
	private onResize?: () => void

	constructor() {
		this.input = new ReadStream(openSync("/dev/tty", "r"))
		this.output = new WriteStream(openSync("/dev/tty", "w"))
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.input.setRawMode(true)
		this.input.setEncoding("utf8")
		this.output.write("\x1b[?1049h\x1b[H\x1b[2J")

		const buffer = new StdinBuffer()
		buffer.on("data", (sequence) => onInput(sequence))
		buffer.on("paste", (text) => onInput(text))
		this.buffer = buffer
		this.onData = (data) => buffer.process(data)
		this.input.on("data", this.onData)
		this.input.resume()

		this.onResize = onResize
		this.output.on("resize", onResize)
	}

	stop(): void {
		if (this.onData) this.input.off("data", this.onData)
		if (this.onResize) this.output.off("resize", this.onResize)
		this.buffer?.destroy()
		this.output.write("\x1b[?25h\x1b[?1049l")
		this.input.setRawMode(false)
		this.input.pause()
	}

	/** Close the tty handles so the process can exit. */
	close(): void {
		this.input.destroy()
		this.output.end()
	}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.output.write(data)
	}

	get columns(): number {
		return this.output.columns || 80
	}

	get rows(): number {
		return this.output.rows || 24
	}

	get kittyProtocolActive(): boolean {
		return false
	}

	moveBy(lines: number): void {
		if (lines > 0) this.output.write(`\x1b[${lines}B`)
		else if (lines < 0) this.output.write(`\x1b[${-lines}A`)
	}

	hideCursor(): void {
		this.output.write("\x1b[?25l")
	}

	showCursor(): void {
		this.output.write("\x1b[?25h")
	}

	clearLine(): void {
		this.output.write("\x1b[K")
	}

	clearFromCursor(): void {
		this.output.write("\x1b[J")
	}

	clearScreen(): void {
		this.output.write("\x1b[2J\x1b[H")
	}

	setTitle(title: string): void {
		this.output.write(`\x1b]0;${title}\x07`)
	}

	setProgress(): void {}
}
