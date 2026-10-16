/** Pane-owned Hermes stores; discovery stays outside synchronous polling. */
import type { HerdrPane } from "../shared/protocol.ts";
import { hermesSessionId } from "./hermes-delegations.ts";
import { hermesDbPath, hermesTranscriptForPane } from "./hermes.ts";

export class HermesStores {
  private readonly panes = new Map<string, { session: string; path: string | null; at: number }>();

  constructor(private readonly resolve?: (pane: HerdrPane) => string | Promise<string>) {}

  async refresh(panes: readonly HerdrPane[]): Promise<void> {
    const wanted = new Set(panes.filter((pane) => pane.agent === "hermes" && hermesSessionId(pane)).map((pane) => pane.pane_id));
    for (const id of this.panes.keys()) if (!wanted.has(id)) this.panes.delete(id);
    await Promise.all(panes.map((pane) => this.ensure(pane)));
  }

  async ensure(pane: HerdrPane): Promise<void> {
    const session = pane.agent === "hermes" ? hermesSessionId(pane) : null;
    if (!session) { this.panes.delete(pane.pane_id); return; }
    const known = this.panes.get(pane.pane_id);
    if (known?.session === session && Date.now() - known.at < 30_000) return;
    // a re-discovery keeps the known store until the new answer lands: a gap would read as no subagents and release a held finish
    const entry = { session, path: known?.session === session ? known.path : null, at: Date.now() };
    this.panes.set(pane.pane_id, entry);
    try {
      const resolved = this.resolve ? this.resolve(pane) : hermesTranscriptForPane(pane, pane.cwd ?? "").then((transcript) => transcript.dbPath);
      const path = typeof resolved === "string" ? resolved : await resolved;
      // shortcut: hermesTranscriptForPane answers the server's default store when it cannot see the pane's process, so a session's known store is kept over that answer; upgrade when it reports which store it found
      if (this.panes.get(pane.pane_id) === entry) entry.path = known?.session === session && known.path && path === hermesDbPath() ? known.path : path;
    } catch { /* unavailable stores are retried on the next discovery interval */ }
  }

  path(paneId: string, session: string): string | null {
    const store = this.panes.get(paneId);
    return store?.session === session ? store.path : null;
  }
}
