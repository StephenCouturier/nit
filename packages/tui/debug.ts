import { appendFileSync } from "node:fs"

const ENABLED = process.env.NIT_DEBUG === "1"
const LOG_FILE = process.env.NIT_DEBUG_FILE ?? "/tmp/nit-debug.log"

export function debugLog(event: string, data: Record<string, unknown>): void {
	if (!ENABLED) return
	try {
		appendFileSync(LOG_FILE, `${JSON.stringify({ t: Date.now(), event, ...data })}\n`)
	} catch {
		return
	}
}
