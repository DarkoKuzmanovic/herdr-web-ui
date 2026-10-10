# Backlog

Ideas for this fork (Hermes support in herdr-web-ui). Not committed to; pick from the top.

1. **Multi-select clarify cards.** Questions where several answers can be picked (`[ ]` rows) still get the generic ↑/↓/Enter card. Add checkboxes: toggle with Space, lock with Enter (`parseHermesClarify` in `server/prompt.ts`; returns null today). Do this when Hermes first asks one.

2. **Weekly upstream sync check.** Upstream ships almost daily. A weekly job that rebases `hermes-chat` onto upstream `main` in a scratch worktree, runs the unit tests, and only reports when something conflicts or fails. Deferred: the 2026-10-10 rebase of 25 upstream commits had no conflicts and took minutes; build this when a rebase first hurts.

3. **Upstream the Hermes card reader.** `parseHermesClarify` plus its test is self-contained and useful to every Hermes user of herdr-web-ui. Offer it as a PR to devswha/herdr-web-ui; if merged, idea 2 gets smaller. The plugin (`hermes-plugin/`) stays here, since upstream only reads screens.

## Done or dropped

- **Question in the push alert, answer from the notification** (done): a blocked local pane's alert says the card's question; a plain question with at most two choices gets them as buttons (`withPrompt` in `server/push.ts`, `public/sw.js`). Approvals never get buttons.
- **Clear a stuck state when Hermes dies** (dropped, not needed): tested on herdr 0.9.3, herdr clears the pane's agent and state within a second of Hermes exiting, even after `kill -9`; an interrupted turn and an escaped question both return to idle/done through the existing hooks.
