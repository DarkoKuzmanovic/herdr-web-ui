/**
 * The background subagents (`delegate_task` run async) of each Hermes pane, read-only from
 * Hermes's own store (`$HERMES_HOME/state.db`, table `async_delegations`).
 */

import { Database } from "bun:sqlite";

import type { HerdrPane } from "../shared/protocol.ts";
import { hermesDbPath } from "./hermes.ts";

const BUSY_TIMEOUT_MS = 250;
/** Hermes ids look like `20261010_001436_0d8605`; anything else is not a session this reads. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Hermes's own words for a delegation still at work (tools/async_delegation.py `_LIVE_STATES`). */
const LIVE_DELEGATION = "('running', 'stalling', 'finalizing')";

/** The session herdr's Hermes integration reported for the pane, or null for any other report. */
export function hermesSessionId(pane: Pick<HerdrPane, "agent_session">): string | null {
  const session = pane.agent_session;
  if (session?.agent !== "hermes" || session.source !== "herdr:hermes" || session.kind !== "id" || !SESSION_ID.test(session.value)) return null;
  return session.value;
}

/** Whether the process that owns a delegation still runs: a killed Hermes leaves its rows `running` until it starts again. */
function alive(pid: number | null): boolean {
  if (!pid) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as { code?: string }).code === "EPERM"; }
}

/**
 * The background subagents a Hermes session started and still waits on:
 * at work, or finished with a result not yet handed back, which starts the session's next turn.
 */
export function hermesDelegations(path: string, session: string): { running: number; since: number | null } {
  let db: Database;
  try { db = new Database(path, { readonly: true, create: false }); } catch { return { running: 0, since: null }; }
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const rows = db.query<{ owner_pid: number | null; dispatched_at: number }, [string]>(
      `SELECT owner_pid, dispatched_at FROM async_delegations WHERE origin_session = ?
         AND (state IN ${LIVE_DELEGATION} OR delivery_state = 'pending')`).all(session).filter((row) => alive(row.owner_pid));
    return { running: rows.length, since: rows.length ? Math.max(...rows.map((row) => row.dispatched_at)) * 1000 : null };
  } catch {
    return { running: 0, since: null }; // an older Hermes without the table, or the store busy: nothing known to wait on
  } finally {
    db.close();
  }
}

/**
 * The running delegations of every Hermes pane, read from state.db every `pollMs` and on demand:
 * the count rides the pane like a Claude pane's subagents (`background_tasks`), and a turn that
 * ended while they run is held at rest by BackgroundWait, as Claude's is.
 */
export class HermesDelegations {
  private readonly sessions = new Map<string, string>();
  private readonly counts = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  /** `since`: when the newest of them was started, the prompt BackgroundWait counts its limit from */
  constructor(private readonly deps: { onChange: (paneId: string, running: number, since: number | null) => void; path?: () => string; pollMs?: number }) {}

  start(): void {
    this.timer ??= setInterval(() => this.poll(), this.deps.pollMs ?? 2000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  countOf(paneId: string): number {
    return this.counts.get(paneId) ?? 0;
  }

  /** The Hermes panes of a snapshot and the session each runs; a pane that left Hermes counts nothing. */
  refresh(panes: readonly HerdrPane[]): void {
    const now = new Map(panes.flatMap((pane) => {
      const session = pane.agent === "hermes" ? hermesSessionId(pane) : null;
      return session ? [[pane.pane_id, session] as const] : [];
    }));
    for (const paneId of this.sessions.keys()) if (!now.has(paneId)) this.set(paneId, { running: 0, since: null });
    this.sessions.clear();
    for (const [paneId, session] of now) this.sessions.set(paneId, session);
    this.poll();
  }

  poll(only?: string): void {
    const path = (this.deps.path ?? (() => hermesDbPath()))();
    for (const [paneId, session] of this.sessions) {
      if (only === undefined || only === paneId) this.set(paneId, hermesDelegations(path, session));
    }
  }

  private set(paneId: string, { running, since }: { running: number; since: number | null }): void {
    if ((this.counts.get(paneId) ?? 0) === running) return;
    if (running === 0) this.counts.delete(paneId); else this.counts.set(paneId, running);
    this.deps.onChange(paneId, running, since);
  }
}
