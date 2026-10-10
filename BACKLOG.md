# Backlog

Ideas for this fork (Hermes support in herdr-web-ui). Not committed to; pick from the top.

1. **Weekly upstream sync check.** Upstream ships almost daily. A weekly job that rebases `hermes-chat` onto upstream `main` in a scratch worktree, runs the unit tests, and only reports when something conflicts or fails. Deferred: the 2026-10-10 rebase of 25 upstream commits had no conflicts and took minutes; build this when a rebase first hurts.

## Done or dropped

- **Upstream the Hermes card reader** (PR open): [devswha/herdr-web-ui#750](https://github.com/devswha/herdr-web-ui/pull/750). Once merged, drop the card commits from `hermes-chat` at the next rebase. Upstream's own Hermes chat-reader PRs (#604, #680) overlap our `server/hermes.ts`; if one merges, drop ours in favour of it.
- **Multi-select clarify cards** (done): `[ ]` rows become a multi-select card; Space ticks, Enter locks (`parseHermesClarify`). Checked live: Blue + Green reached Hermes. Typed text on a multi-select question isn't offered (the card can't combine it with ticks).
- **Question in the push alert, answer from the notification** (done): a blocked local pane's alert says the card's question; a plain question with at most two choices gets them as buttons (`withPrompt` in `server/push.ts`, `public/sw.js`). Approvals never get buttons.
- **Clear a stuck state when Hermes dies** (dropped, not needed): tested on herdr 0.9.3, herdr clears the pane's agent and state within a second of Hermes exiting, even after `kill -9`; an interrupted turn and an escaped question both return to idle/done through the existing hooks.
