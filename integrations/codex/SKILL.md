---
name: nit
description: Open nit so the user can review your changes, then address their comments. Use only when the user invokes $nit or explicitly asks for a nit review.
---
Run `nit popup` in the shell, adding any flags the user gave with `$nit` (`--branch`, `--base <ref>`). It opens a review window for the user and prints their code review of your changes when they close it. They may take a long time, so give the command a timeout of at least an hour (3600000 ms).

Always run it outside the sandbox: request escalated permissions on the first attempt, with a justification like "open the nit review window". It has to open a pane through herdr, tmux or Hyprland and write nit's data, which the sandbox blocks.

If its output says the review was cancelled or could not open, tell the user that in one line, including the reason it gives, and stop.

Otherwise, work through every comment in it now. Follow the review's own instructions: fix the "Fix these" items, answer the "Answer these" items without editing files, and after handling each thread run the `nit reply` command it gives you with that thread's id.
