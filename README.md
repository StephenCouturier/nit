# nit

Review your coding agent's changes in a terminal UI, leave line-anchored comments, and hand them back to the agent to fix. Works with Claude Code, Codex, opencode and pi, or any other CLI agent, a pipe, the clipboard, or a file.

Walk the diff, comment, hit `F`. A **handler** delivers the comments as a structured work list, and the agent's per-thread replies land back on your comment threads.

## Install

Requires Node >= 23.6 and git (and pi >= 0.85 for the pi extension).

**1. Put `nit` on your PATH:**

```sh
git clone https://github.com/StephenCouturier/nit && cd nit
npm install && npm link
```

**2. Add `/nit` to your agent** (`$nit` in Codex; `--project` installs into the current repo only):

```sh
nit install claude               # /nit in Claude Code
nit install opencode             # /nit in opencode
nit install codex                # $nit skill in Codex
nit install pi                   # /nit extension in pi (or, inside pi: pi install git:github.com/StephenCouturier/nit)
```

In Claude Code, opencode and Codex, the installed command opens the review in a herdr pane, a tmux popup or a floating Hyprland terminal, so run the agent inside one of those (pi shows it inline). Elsewhere, run `nit --copy` in another terminal and paste the result into the agent.

Rerunning `nit install <agent>` leaves identical command files alone. For Claude Code, opencode and Codex, use `--force` to replace an existing command or skill that differs.

`--copy` needs a working clipboard helper: `wl-copy` (Wayland), `xclip` or `xsel` (X11), `pbcopy` (macOS), or `clip.exe` (WSL).

In Codex, `$nit` has to run outside the sandbox, which blocks the herdr, tmux and Hyprland sockets. Approve the escalation when Codex asks.

**3. Optional: MCP replies.** With nit's MCP server the agent reports back per thread, instead of through `nit reply` or by having its final message parsed:

```sh
claude mcp add nit -- nit mcp
codex mcp add nit -- nit mcp
```

## Usage

From inside an agent, run `/nit` (or `$nit` in Codex). From a shell, run `nit`:

```
nit                  review only uncommitted changes (staged, unstaged, untracked)
nit --branch         review the whole branch against its auto-detected base
nit --base origin/dev   review the branch against an explicit base ref (in pi: /nit origin/dev)
```

By default the diff covers only what you haven't committed yet, diffed against `HEAD`. With `--branch` (or `-b`), or an explicit base ref, it covers everything on the branch: commits since the merge base, plus staged, unstaged, and untracked files.

Base detection tries `origin/HEAD`, then `origin/main`, `origin/master`, `origin/develop`, then the local `main`, `master`, and `develop` branches. Use `--base <ref>` if none matches your workflow.

Comments live in the same per-branch file regardless of scope, so a comment left on uncommitted changes is still there when you open the full branch review.

### Keys

| Key | Action |
| --- | --- |
| `j` / `k` / `↓` / `↑` | Move cursor |
| `n` / `p` (or `]` / `[`) | Next / previous hunk |
| `/` / `?` | Search forward / backward (regex, smartcase, jumps as you type) |
| `n` / `N` | Repeat the last search / reverse its direction; `esc` clears highlighting but retains the search (`]` / `[` still navigate hunks) |
| `g` / `G` | Jump to top / bottom |
| `ctrl+d` / `ctrl+u` | Page down / up |
| `h` / `l` | Split view: comment on the left (old) or right (new) side |
| `c` | Comment on the current line, or on the selected range |
| `v` | Start / cancel a range selection (then move and press `c`) |
| `tab` | Switch between fix and question (while typing a comment, or on a thread) |
| `r` | Reply to the thread under the cursor |
| `x` | Toggle done |
| `d` | Delete the thread |
| `space` | Mark the file viewed (collapses it) / unviewed |
| `\` | Toggle side-by-side view (remembered; needs 100+ columns) |
| `#` | Toggle line numbers (remembered) |
| `F` | Send all open comments |
| `q` / `esc` / `ctrl+c` | Close in browse mode (`esc` / `ctrl+c` first clear a selection or search highlighting) |

Every key can be rebound; see [Configuration](#configuration).

Viewed files are saved per branch along with a hash of their diff. If the agent changes a viewed file, it reopens with a "changed since viewed" badge.

## Fixes vs. questions

Every comment is a **fix** (change the code) or a **question** (answer only). Press `tab` while typing to switch. On send, the prompt is split into **Fix these** and **Answer these**. Questions are explicitly "do NOT modify any files". Fix threads move `open → fixing → resolved`; questions move `open → asking → answered`.

## Configuration

Configuration lives in `$NIT_CONFIG_DIR`, or `$XDG_CONFIG_HOME/nit/` (default `~/.config/nit/`). The examples below include explanatory comments; remove them when saving `config.json`, which must be valid JSON:

```jsonc
// config.json
{
  "theme": "terminal",            // default: your terminal's palette, or a base16 scheme file, e.g. "tomorrow-night.yaml"
  "keys": { "send": "ctrl+s", "down": ["j", "down"] },
  "context": 3,                    // diff lines shown around each comment in the prompt
  "handler": "stdout",             // where `nit` sends a review by default (see Handlers)
  "handlers": {}                   // extra agents, or overrides of the built-in ones
}
```

- **Themes:** any base16 scheme works as-is, including the hundreds in [tinted-theming/schemes](https://github.com/tinted-theming/schemes). Drop the `.yaml` file next to `config.json` and name it in `"theme"`.
- **Keys:** the actions are `down up left right nextHunk prevHunk top bottom pageDown pageUp viewed range comment reply toggleType resolve delete send split lineNumbers search searchBack searchNext searchPrev quit`. Key ids look like `j`, `G`, `ctrl+d`, `tab`, `shift+tab`, `space` or `pageDown`.
- **Prompt text:** `header.md` replaces the opening line and `footer.md` replaces the closing guidelines. Both can use `{count}`, `{fixes}`, `{questions}`, `{base}` and `{branch}`. The "how to respond" instructions between them are always included, because replies depend on them.

## How it works

Comments are threads, not one-shot notes. Each has a kind, a status (`open` → `fixing` → `resolved`), and a message list that both you and the agent append to.

When you send, nit marks the threads in flight, records a batch, and renders one prompt with `file.ts:42` anchors and the surrounding diff quoted. The handler only delivers it. Delivering into the agent's own session (the pi extension, `/nit`, or `--continue`) means the agent already has the context of the code it just wrote.

The review UI closes while the agent works. Reopen it to see the result: threads are re-anchored onto the new line numbers by matching their source line, and any thread whose anchor disappeared is flagged `moved` rather than silently dropped.

## Handlers

A handler decides where the review goes when you press `F`. From a shell, pick one with `--to`, or set a default with `"handler"` in config.json (otherwise it's `stdout`):

```sh
nit                                    # stdout: nit | claude -p,  nit | codex exec -
nit --copy                             # clipboard, to paste into a running agent
nit --out review.md                    # a file
nit --to claude                        # a new Claude Code session, seeded with the review
nit --to codex --continue              # the agent's most recent session here, which already knows its changes
nit --to opencode --headless           # run to completion, print the output, settle from it
nit handlers                           # list every handler and whether it's installed
```

The modes also work as a suffix: `--to claude:continue`, `--to pi:headless`.

| Handler | Delivers to | Replies |
| --- | --- | --- |
| `stdout`, `clipboard`, `file` | whatever you pipe or paste into | agent runs `nit reply`; batch stays pending until it does |
| `claude`, `codex`, `opencode`, `pi` | the agent CLI, `start` / `continue` / `headless` | interactive: `nit reply`, settled when the agent exits. Headless: `### N.` sections parsed from its output |
| `/nit` slash command | the session you ran it in, via `nit popup` | `nit reply` |
| pi extension | the running pi session | `### N.` sections, settled when the agent finishes its turn |

Threads the agent never replied to are flagged `needs_review` (shown as `check`) when a batch settles, not silently marked done. `--reply cli|tool|sections` overrides how the agent is told to report back.

### Adding an agent

Any CLI agent is a few lines of config. Each mode is an argv; `{prompt}` becomes the review as one argument, `{file}` the path of a temp file holding it. With neither, `headless` gets the review on stdin and the interactive modes get it as the last argument.

```jsonc
// ~/.config/nit/config.json
{
  "handler": "claude",
  "handlers": {
    "aider":  { "description": "aider", "start": ["aider", "--message-file", "{file}"] },
    // override a built-in field by field, e.g. let headless Claude edit files
    "claude": { "headless": ["claude", "-p", "--permission-mode", "acceptEdits"] }
  }
}
```

Built-in headless modes run with the agent's default permissions, which usually means they can answer questions but not edit files. Add your agent's flags as above if you want headless fixes.

Reviews larger than 100,000 bytes passed as command-line arguments (including `{prompt}`) are swapped for a short pointer telling the agent to run `nit show <batchId>`.

Hosts that embed nit (like the pi extension) implement the `Handler` interface in `packages/core/handler.ts` directly.

### Slash commands and `nit popup`

`/nit` runs `nit popup`, which opens the review in a herdr pane, a tmux popup or a floating Hyprland terminal, waits for you, and returns the review into the session. Claude Code and opencode run it directly; the Codex skill asks Codex to run it outside the sandbox with a long timeout.

Quitting the standalone review without sending prints no review and exits 130. `nit popup` instead prints `Review cancelled: no comments were sent.` when no review is returned; the installed integrations tell the agent to stop in that case. A shell pipeline still starts its downstream command even if the standalone review is cancelled.

Popup launchers are tried in order: herdr, tmux, then Hyprland. The Hyprland launcher needs `hyprctl` and either `alacritty` or `xdg-terminal-exec`. The popup waits up to an hour by default; set `NIT_POPUP_TIMEOUT` to change that limit in seconds.

Other commands:

```sh
nit pending [--json]                   # sent threads that have no reply yet
nit history [--json]                   # every batch you've sent, with its replies
nit show <batchId>                     # the stored full review prompt
nit reply <threadId> --status resolved -m "Fixed the boundary check."
nit reply <threadId> --status answered < answer.md
nit settle <batchId> < answer.md       # route an agent's "### N." sections back onto threads
nit settle <batchId> --file answer.md  # same, reading from a file
nit dispatch [--to <handler>]          # non-interactive: send all open threads (default stdout)
nit mcp                               # MCP server on stdio
```

Run reply and batch commands from the same repository and branch as the review. `nit reply` accepts text from `-m` / `--message` or stdin; without `--status`, fixes become `resolved` and questions become `answered`.

`nit dispatch` also accepts `--branch`, `--base <ref>`, and `--reply cli|tool|sections`. Add `--compact` to send a short pointer to `nit show <batchId>` instead of the full prompt (not used with section-based replies). Unlike the interactive review, dispatch defaults to stdout even when a handler is configured.

The MCP server (see [Install](#install)) exposes `review_list_pending`, `review_get` and `review_reply`.

Agent replies may set `resolved`, `answered`, `wontfix` or `needs_info`.

## State

Reviews persist per repo and branch at:

```
~/.local/share/nit/<repo>/<branch>.json            threads (live state)
~/.local/share/nit/<repo>/<branch>/batches/*.json  one file per dispatch: what was sent, how, and each reply
```

Override the root with `NIT_HOME` (or `XDG_DATA_HOME`). Coming from llm-review? The first run copies `~/.local/share/llm-review/` and `~/.config/llm-review/` to their nit locations (the originals are left alone), and the pi extension still picks up reviews saved under `~/.pi/agent/llm-review/`.

Review state is stored outside the repository. Explicit operations such as `--out review.md` and `nit install <agent> --project` can still write files there.

Thread saves merge against what is already on disk, keyed by thread id (newest `updatedAt` wins), preserving newer replies from other sessions in normal use. Writes use atomic file replacement, but there is no cross-process locking, so simultaneous saves can still race. A thread is only removed when you explicitly delete it with `d`.

Set `NIT_DEBUG=1` to append render/geometry diagnostics to `/tmp/nit-debug.log` (override with `NIT_DEBUG_FILE`).

## Known limitations

- Comments are single-line input; use `r` to add detail across multiple replies.
- No intra-line (word-level) diff highlighting, just line-level colors.
- Very large diffs are not capped and may be slow to open.
- Threads are re-anchored by matching their source line; if the agent rewrites a line beyond recognition the thread is flagged `moved` rather than relocated.

## License

MIT
