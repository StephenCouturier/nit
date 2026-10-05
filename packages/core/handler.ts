import type { ReviewBatch } from "./batch.ts"
import type { ReplyVia } from "./render.ts"

/**
 * Where a review goes when the user sends it. nit renders the prompt and records the
 * batch; the handler only delivers it: to stdout, the clipboard, a file, a fresh or
 * resumed agent session, or (for hosts that embed nit, like the pi extension) straight
 * into the running conversation.
 *
 * Built-in handlers live in packages/handlers. Any CLI agent can be added from
 * config.json without code (see packages/handlers/agent.ts).
 */
export interface Handler {
	name: string
	description: string
	/** How the agent reports back per thread, unless the user overrides it. */
	replyVia: ReplyVia
	/** Help-bar label for the send key, e.g. "emit", "copy", "send to claude". */
	sendLabel?: string
	/** Throws if the handler can't run here (e.g. the agent isn't installed), before anything is dispatched. */
	preflight?(): void
	deliver(delivery: Delivery): Promise<Delivered>
}

export interface Delivery {
	prompt: string
	batch: ReviewBatch
	cwd: string
}

export interface Delivered {
	/** One line for the user. */
	message?: string
	/**
	 * The agent is done with the batch (e.g. its process exited): settle it now. Threads it
	 * never replied to are routed from `finalText`'s numbered sections, or flagged for review.
	 */
	finished?: boolean
	finalText?: string
}

/**
 * A CLI agent, described as data so new ones can be added in config.json:
 *
 *   "handlers": { "aider": { "start": ["aider", "--message", "{prompt}"] } }
 *
 * Each mode is an argv. `{prompt}` becomes the review text as one argument, `{file}` the
 * path of a temp file holding it. A headless argv with neither gets the review on stdin.
 * Built-in specs (claude, codex, opencode, pi) can be overridden field by field.
 */
export interface AgentSpec {
	description?: string
	/** A new interactive session seeded with the review. */
	start?: string[]
	/** The agent's most recent session in this directory, which already has the context of its changes. */
	continue?: string[]
	/** Run to completion without a UI; its stdout is shown and parsed for `### N.` replies. */
	headless?: string[]
}

export type AgentMode = "start" | "continue" | "headless"
export const AGENT_MODES: AgentMode[] = ["start", "continue", "headless"]
