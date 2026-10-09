# Backlog

Ideas for this fork (Hermes support in herdr-web-ui). Not committed to; pick from the top.

1. **Question in the push alert, answer from the notification.** The "needs input" alert says only that a pane is waiting. Put the question in the alert body, and for a card with 2–3 choices add them as notification buttons, so a quick answer doesn't need the app opened. (`server/push.ts` builds the body; `public/sw.js` handles the click.)

2. **Clear a stuck "working" / "blocked" state when Hermes dies.** If Hermes crashes or is killed mid-turn, the plugin never reports `idle`, so the pane looks busy (or waiting) forever and the phone keeps a dead card. Report `idle` on process exit (`atexit` in `hermes-plugin/__init__.py`).

3. **Multi-select clarify cards.** Questions where several answers can be picked (`[ ]` rows) still get the generic ↑/↓/Enter card. Add checkboxes: toggle with Space, lock with Enter (`parseHermesClarify` in `server/prompt.ts`; returns null today). Do this when Hermes first asks one.

4. **Weekly upstream sync check.** Upstream ships almost daily (it was already 2 commits ahead on 2026-10-10). A weekly job that rebases `hermes-chat` onto upstream `main` in a scratch worktree, runs the unit tests, and only reports when something conflicts or fails, so the fork doesn't drift until a merge is painful.

5. **Upstream the Hermes card reader.** `parseHermesClarify` plus its test is self-contained and useful to every Hermes user of herdr-web-ui. Offer it as a PR to devswha/herdr-web-ui; if merged, idea 4 gets smaller. The plugin (`hermes-plugin/`) stays here, since upstream only reads screens.
