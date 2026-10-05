import { TuiMainScreen } from "@earendil-works/pi-tui"
import { loadConfig, loadUiPrefs, saveUiPrefs } from "../core/config.ts"
import type { LoadedReview } from "../core/review.ts"
import { saveState } from "../core/store.ts"
import type { Thread } from "../core/threads.ts"
import { resolveKeys } from "./keys.ts"
import { ReviewComponent } from "./review-component.ts"
import { loadTheme } from "./theme.ts"
import { TtyTerminal } from "./tty-terminal.ts"

export interface TuiResult {
	/** Open threads when the user sent, or empty when they quit without sending. */
	threads: Thread[]
	deleted: Set<string>
}

/** Run the review UI full-screen on /dev/tty until the user sends or quits. */
export function runReviewTui(loaded: LoadedReview, options: { sendLabel?: string } = {}): Promise<TuiResult> {
	// Resolve config before touching the terminal so mistakes print as normal errors.
	const config = loadConfig()
	const keys = resolveKeys(config.keys)
	const theme = loadTheme(config.theme)

	const terminal = new TtyTerminal()
	const tui = new TuiMainScreen(terminal)
	const deleted = new Set<string>()

	return new Promise((resolve) => {
		let finished = false
		const finish = (threads: Thread[]) => {
			if (finished) return
			finished = true
			tui.stop()
			terminal.close()
			resolve({ threads, deleted })
		}

		const component = new ReviewComponent({
			tui,
			theme,
			keys,
			files: loaded.files,
			state: loaded.state,
			sendLabel: options.sendLabel,
			chromeRows: 5,
			prefs: loadUiPrefs(),
			onPrefsChange: (prefs) => void saveUiPrefs(prefs),
			onChange: (deletedId) => {
				if (deletedId) deleted.add(deletedId)
				void saveState(loaded.file, loaded.state, deleted)
			},
			onSend: (threads) => finish(threads),
			onClose: () => finish([]),
		})

		tui.addChild(component)
		tui.setFocus(component)
		tui.start()
		tui.requestRender()
	})
}
