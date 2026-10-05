# nit

Review your coding agent's changes in a terminal UI, leave line-anchored comments, and hand them back to the agent to fix. Works with Claude Code, Codex, opencode, pi, any other CLI agent, a pipe, the clipboard, or a file.

Walk the diff, comment, press `F`. The agent gets a structured work list, and its replies land back on your comment threads.

## Install

Requires Node >= 23.6 and git (pi >= 0.85 for the pi extension).

```sh
git clone https://github.com/StephenCouturier/nit && cd nit
npm install && npm link

nit install claude      # /nit in Claude Code
nit install opencode    # /nit in opencode
nit install codex       # $nit skill in Codex
nit install pi          # /nit extension in pi (or inside pi: pi install git:github.com/StephenCouturier/nit)
```

`--project` installs into the current repo only; `--force` replaces an existing command that differs.

In Claude Code, opencode and Codex, `/nit` opens the review in a herdr pane, tmux popup, or floating Hyprland terminal (needs `hyprctl` plus `alacritty` or `xdg-terminal-exec`), so run the agent inside one of those. pi shows it inline. In Codex, approve the sandbox escalation when asked. Anywhere else, run `nit --copy` in another terminal and paste the result into the agent.

Optional: the MCP server lets the agent reply per thread:

```sh
claude mcp add nit -- nit mcp
codex mcp add nit -- nit mcp
```

## Usage

```sh
nit                     # uncommitted changes (staged, unstaged, untracked) vs HEAD
nit --branch            # the whole branch vs its auto-detected base (origin/HEAD, main, master, develop)
nit --base origin/dev   # the branch vs an explicit base (in pi: /nit origin/dev)
```

Comments are stored per branch, whatever the scope, so the full-branch review still shows comments you left on uncommitted changes.

Every comment is either a **fix** (change the code) or a **question** (answer only, don't modify files). Press `tab` to switch between them. Fixes move `open → fixing → resolved` and questions move `open → asking → answered`. When you reopen nit after the agent's changes, threads are re-anchored to their new lines. A thread whose line is gone is flagged `moved`, and one the agent never replied to is flagged `check`.

### Keys

| Key | Action |
| --- | --- |
| `j` `k` / `g` `G` / `ctrl+d` `ctrl+u` | Move / top, bottom / page |
| `n` `p` (or `]` `[`) | Next / previous hunk |
| `/` `?`, then `n` `N` | Regex search forward / back, then repeat |
| `c`, `v` | Comment on line; start a range selection |
| `h` `l` | In split view, comment on the old / new side |
| `tab` | Toggle fix / question |
| `r` / `x` / `d` | Reply / toggle done / delete thread |
| `space` | Mark file viewed (reopens if the agent changes it) |
| `\` / `#` | Side-by-side view (100+ cols) / line numbers |
| `F` | Send all open comments |
| `q` `esc` `ctrl+c` | Quit |

## Handlers

The handler decides where the review goes when you press `F`. Choose one with `--to`, or set `"handler"` in config.json. The default is `stdout`.

```sh
nit | claude -p                 # stdout
nit --copy                      # clipboard (wl-copy, xclip, xsel, pbcopy, clip.exe)
nit --out review.md             # file
nit --to claude                 # new agent session (claude, codex, opencode, pi)
nit --to codex --continue       # the agent's last session here, which knows its changes
nit --to opencode --headless    # run to completion, settle threads from its output
nit handlers                    # list handlers and whether each is installed
```

Modes also work as a suffix: `--to pi:headless`. Agents report back with `nit reply`, the MCP tools, or numbered `### N.` sections in headless output. `--reply cli|tool|sections` overrides which one they're told to use. Headless agents run with their default permissions, so they can usually answer questions but not edit files.

To add an agent, or override a built-in one, edit the config. `{prompt}` is replaced with the review text and `{file}` with the path to a temp file containing it:

```jsonc
"handlers": {
  "aider":  { "description": "aider", "start": ["aider", "--message-file", "{file}"] },
  "claude": { "headless": ["claude", "-p", "--permission-mode", "acceptEdits"] }
}
```

## Commands

```sh
nit pending [--json]               # sent threads with no reply yet
nit history [--json]               # past batches on this branch
nit show <batchId>                 # a batch's full prompt
nit reply <threadId> [--status resolved|answered|wontfix|needs_info] -m "..."   # or text on stdin
nit settle <batchId> [--file f]    # route "### N." sections back onto threads
nit dispatch [--to h] [--compact]  # send open threads without the TUI
nit popup                          # what /nit runs: open the TUI in a popup, print the review
nit mcp                            # MCP server: review_list_pending, review_get, review_reply
```

## Configuration

Config lives in `~/.config/nit/` (or `$XDG_CONFIG_HOME/nit/`, or `$NIT_CONFIG_DIR`). `config.json` must be plain JSON; the comments below are explanatory:

```jsonc
{
  "theme": "terminal",      // or a base16 .yaml scheme placed next to config.json
  "keys": { "send": "ctrl+s", "down": ["j", "down"] },
  "context": 3,             // diff lines quoted around each comment
  "handler": "stdout",
  "handlers": {}
}
```

Any key can be rebound. An unknown action name causes an error that lists the valid ones. To replace the prompt's opening line or closing guidelines, add `header.md` or `footer.md`. Both can use `{count}`, `{fixes}`, `{questions}`, `{base}` and `{branch}`.

## State

Threads and batches are stored outside the repo, in `~/.local/share/nit/<repo>/<branch>.json` and `<branch>/batches/`. Set `NIT_HOME` or `XDG_DATA_HOME` to move them. The first run copies over existing llm-review data. Saves merge by thread id, but there is no cross-process locking. Set `NIT_DEBUG=1` to log render diagnostics to `/tmp/nit-debug.log`.

## Known limitations

- Comments are single-line; add detail with replies.
- No word-level diff highlighting.
- Very large diffs aren't capped and may be slow.

## License

MIT
