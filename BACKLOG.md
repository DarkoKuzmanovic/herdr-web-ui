# Backlog

Ideas for this fork (Hermes support in herdr-web-ui). Not committed to; pick from the top.

## Done or dropped

- **Weekly upstream sync check** (done): Hermes cron job `0efbaa86139b`, Mondays 08:30, script `~/.hermes/scripts/herdr-web-ui-upstream-check.sh`. Rebases `origin/hermes-chat` onto `upstream/main` in a throwaway worktree and runs typecheck + unit tests; sends WhatsApp only on a conflict or failure, silent otherwise. It never rebases the real branch: do that by hand when it's quiet.
- **Upstream the Hermes card reader** (PR open): [devswha/herdr-web-ui#750](https://github.com/devswha/herdr-web-ui/pull/750). Once merged, drop the card commits from `hermes-chat` at the next rebase. Upstream's own Hermes chat-reader PRs (#604, #680) overlap our `server/hermes.ts`; if one merges, drop ours in favour of it.
- **Multi-select clarify cards** (done): `[ ]` rows become a multi-select card; Space ticks, Enter locks (`parseHermesClarify`). Checked live: Blue + Green reached Hermes. Typed text on a multi-select question isn't offered (the card can't combine it with ticks).
- **Question in the push alert, answer from the notification** (done): a blocked local pane's alert says the card's question; a plain question with at most two choices gets them as buttons (`withPrompt` in `server/push.ts`, `public/sw.js`). Approvals never get buttons.
- **Hermes slash commands on the phone** (done): `/` in the chat box lists Hermes's own commands with its descriptions (`hermes:` in `server/commands.ts`), minus pickers, PC-only actions (clipboard, editor, mic) and display toggles.
- **Answer in the "finished" alert** (done): a local pane's finish alert ends with the first line of the agent's last answer (`replyLine` in `server/push.ts`), for every agent with a chat history. Upstream PR candidate.
- **Hermes background subagents** (done): async `delegate_task` runs from Hermes's `state.db` (`async_delegations`) show as "N background" on the pane and hold its finish alert until they report back (`HermesDelegations` in `server/hermes.ts`). Rows of a dead Hermes are ignored.
- **Approval and Yes/No cards** (done): Hermes's dangerous-command approval (Allow once / this session / always / Deny) and its own Yes/No confirm (e.g. `/clear`) are cards (`parseHermesApproval`). Answered by arrows, never digits; no notification buttons for approvals. Only seen with `approvals.mode` not `off`.
- **Clear a stuck state when Hermes dies** (dropped, not needed): tested on herdr 0.9.3, herdr clears the pane's agent and state within a second of Hermes exiting, even after `kill -9`; an interrupted turn and an escaped question both return to idle/done through the existing hooks.
