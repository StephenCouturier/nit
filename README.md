# nit

A [pi](https://pi.dev) extension for reviewing your branch's changes in a TUI and handing the comments to the agent to fix.

Run `/nit`, walk the diff, leave line-anchored comments, hit `F`. The agent gets your comments as a structured work list, fixes them in the same session with full context, and its reply is attached back onto each comment thread.

## Install

```sh
pi install git:github.com/StephenCouturier/nit
```

Or try it for a single run without installing:

```sh
pi -e git:github.com/StephenCouturier/nit
```

## Usage

```
/nit              review only uncommitted changes (staged, unstaged, untracked)
/nit --branch     review the whole branch against its auto-detected base
/nit origin/dev   review the branch against an explicit base ref
```

By default the diff covers only what you haven't committed yet, diffed against `HEAD`. With `--branch` (or `-b`), or an explicit base ref, it covers everything on the branch: commits since the merge base, plus staged, unstaged, and untracked files.

Comments live in the same per-branch file regardless of scope, so a comment left on uncommitted changes is still there when you open the full branch review.

### Keys

| Key | Action |
| --- | --- |
| `j` / `k` / `↓` / `↑` | Move cursor |
| `n` / `p` (or `]` / `[`) | Next / previous hunk |
| `/` / `?` | Search forward / backward (regex, smartcase, jumps as you type) |
| `n` / `N` | Next / previous match while a search is active (`esc` clears it, then `n` is next hunk again) |
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
| `q` / `esc` | Close |

Every key can be rebound; see [Configuration](#configuration).

Viewed files are saved per branch along with a hash of their diff. If the agent changes a viewed file, it reopens with a "changed since viewed" badge.

## Fixes vs. questions

Every comment is a **fix** (change the code) or a **question** (answer only). Press `tab` while typing to switch. On send, the prompt is split into **Fix these** and **Answer these**. Questions are explicitly "do NOT modify any files". Fix threads move `open → fixing → resolved`; questions move `open → asking → answered`.

## Configuration

Everything lives in `~/.config/nit/` (or `$NIT_CONFIG_DIR`):

```jsonc
// config.json
{
  "theme": "terminal",            // default: your terminal's palette, or a base16 scheme file, e.g. "tomorrow-night.yaml"
  "keys": { "send": "ctrl+s", "down": ["j", "down"] },
  "context": 3                     // diff lines shown around each comment in the prompt
}
```

- **Themes:** any base16 scheme works as-is, including the hundreds in [tinted-theming/schemes](https://github.com/tinted-theming/schemes). Drop the `.yaml` file next to `config.json` and name it in `"theme"`.
- **Keys:** the actions are `down up left right nextHunk prevHunk top bottom pageDown pageUp viewed range comment reply toggleType resolve delete send split lineNumbers search searchBack searchNext searchPrev quit`. Key ids look like `j`, `G`, `ctrl+d`, `tab`, `shift+tab`, `space` or `pageDown`.
- **Prompt text:** `header.md` replaces the opening line and `footer.md` replaces the closing guidelines. Both can use `{count}`, `{fixes}`, `{questions}`, `{base}` and `{branch}`. The "how to respond" instructions between them are always included, because replies depend on them.

## How it works

Comments are threads, not one-shot notes. Each has a severity, a status (`open` → `fixing` → `resolved`), and a message list that both you and the agent append to.

When you dispatch, the extension builds a prompt in `CRITICAL` / `WARNING` / `SUGGESTION` form with `file.ts:42` anchors and the relevant source line quoted, then sends it into the current pi session with `sendUserMessage`. Because it's the same session, the agent already has the context of the code it just wrote.

The review UI closes while the agent works, so you can watch the transcript. Reopen with `/nit` to see the result: threads are re-anchored onto the new line numbers by matching their source line, and any thread whose anchor disappeared is flagged `moved` rather than silently dropped.

## Standalone (any agent)

The same review UI runs outside pi as a filter, like `fzf`. It draws on `/dev/tty`, and when you press `f`/`F` it writes the review to stdout as markdown, with the diff around each comment and its line numbers. Pipe that into whatever agent you use:

```sh
npm install                                   # once, for the TUI dependency (Node >= 23.6)
alias nit='node /path/to/nit/packages/cli/nit.ts'

nit | claude -p                        # review, then hand it to a headless agent
nit | codex exec -
nit --copy                             # to the clipboard, to paste into a running agent
nit --out review.md                    # or a file
nit --branch                           # the whole branch, not just uncommitted changes; --base <ref> for an explicit base
```

Quitting with `q` prints nothing and exits 130, so nothing downstream runs.

By default the markdown tells the agent to report back per thread with the CLI, so replies land on your threads whatever agent you use:

```sh
nit reply <threadId> --status resolved|answered|wontfix|needs_info -m "what changed"
```

Other commands:

```sh
nit pending                            # sent, not yet replied
nit history                            # every batch you've sent, with its replies
nit show <batchId>                     # the exact markdown that was sent
nit settle <batchId> < answer.md       # route an agent's "### N." sections back onto threads
nit dispatch                           # non-interactive: send all open threads
nit mcp                                # MCP server on stdio
```

The MCP server exposes `review_list_pending`, `review_get` and `review_reply`, so an agent reports back per thread instead of having its final message parsed. For example, with Claude Code:

```sh
claude mcp add nit -- node /path/to/nit/packages/cli/nit.ts mcp
```

Agent replies may set `resolved`, `answered`, `wontfix` or `needs_info`. Threads still in flight when a batch settles without a reply are flagged `needs_review` (shown as `check`) instead of being marked done.

## State

Reviews persist per repo and branch at:

```
~/.local/share/nit/<repo>/<branch>.json            threads (live state)
~/.local/share/nit/<repo>/<branch>/batches/*.json  one file per dispatch: what was sent, how, and each reply
```

Override the root with `NIT_HOME` (or `XDG_DATA_HOME`). Coming from llm-review? The first run copies `~/.local/share/llm-review/` and `~/.config/llm-review/` to their nit locations (the originals are left alone), and the pi extension still picks up reviews saved under `~/.pi/agent/llm-review/`.

Nothing is written into the repository you're reviewing.

Saves merge against what is already on disk, keyed by thread id (newest `updatedAt` wins), so two sessions, the MCP server and the CLI can all write to the same branch without clobbering each other. A thread is only removed when you explicitly delete it with `d`.

Set `NIT_DEBUG=1` to append render/geometry diagnostics to `/tmp/nit-debug.log` (override with `NIT_DEBUG_FILE`).

## Requirements

- pi >= 0.85
- git

## Known limitations

- Comments are single-line input; use `r` to add detail across multiple replies.
- No intra-line (word-level) diff highlighting, just line-level colors.
- Very large diffs are not capped and may be slow to open.
- Threads are re-anchored by matching their source line; if the agent rewrites a line beyond recognition the thread is flagged `moved` rather than relocated.

## License

MIT
