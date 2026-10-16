/**
 * The background subagents (`delegate_task` run async) of each Hermes pane, read-only from
 * Hermes's own store (`$HERMES_HOME/state.db`, table `async_delegations`).
 */

import { Database } from "bun:sqlite";

import type { HerdrPane, OmoTaskResult } from "../shared/protocol.ts";
import { HermesStores } from "./hermes-stores.ts";

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

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const numeric = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const text = (value: unknown): string | null => typeof value === "string" ? value : null;

/** Completion evidence belongs to this session; missing or newer shapes retain the original notice. */
export function hermesDelegationResults(db: Database, session: string, content: string): OmoTaskResult[] | null {
  const match = /^\[ASYNC DELEGATION BATCH COMPLETE — (deleg_[A-Za-z0-9_-]+)\](?:\r?\n|$)/.exec(content);
  if (!match) return null;
  try {
    const row = db.query<{ task_json: string; result_json: string }, [string, string]>(
      "SELECT task_json, result_json FROM async_delegations WHERE delegation_id = ? AND origin_session = ?",
    ).get(match[1]!, session);
    if (!row) return null;
    const task = record(JSON.parse(row.task_json) as unknown);
    const batch = record(JSON.parse(row.result_json) as unknown);
    if (!task || !Array.isArray(batch?.results) || batch.results.length === 0) return null;
    const tasks: OmoTaskResult[] = [];
    for (const value of batch.results) {
      const result = record(value);
      const index = numeric(result?.task_index);
      if (!result || index === null || !Number.isSafeInteger(index)) return null;
      const title = text(Array.isArray(task.goals) ? task.goals[index] : null) ?? text(task.goal);
      const summary = text(result.summary);
      const status = result.status === "completed" ? "completed"
        : ["error", "failed", "timeout"].includes(String(result.status)) ? "failed"
        : ["interrupted", "cancelled"].includes(String(result.status)) ? "cancelled" : null;
      if (title === null || summary === null || status === null) return null;
      const usage = record(result.tokens);
      const input = numeric(usage?.input ?? 0);
      const output = numeric(usage?.output ?? 0);
      const tokens = usage ? input !== null && output !== null && ("input" in usage || "output" in usage) ? numeric(input + output) : null : numeric(result.tokens);
      const seconds = numeric(result.duration_seconds);
      tasks.push({
        id: `${match[1]}:${index}`,
        title,
        agent: text(task.role),
        model: text(result.model) ?? text(task.model),
        status,
        duration_ms: seconds === null ? null : numeric(seconds * 1000),
        turns: numeric(result.api_calls),
        tool_calls: Array.isArray(result.tool_trace) ? result.tool_trace.length : null,
        tokens,
        result: summary.slice(0, 16_000),
        ...(summary.length > 16_000 || result.truncated === true ? { result_cut: true } : {}),
      });
    }
    return tasks;
  } catch {
    return null; // older schema, invalid JSON, or a busy store: keep the transcript's own result
  }
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
  private readonly stores: HermesStores;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** `since`: when the newest of them was started, the prompt BackgroundWait counts its limit from */
  constructor(private readonly deps: { onChange: (paneId: string, running: number, since: number | null) => void; path?: (pane: HerdrPane) => string | Promise<string>; pollMs?: number }) {
    this.stores = new HermesStores(deps.path);
  }

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
  async refresh(panes: readonly HerdrPane[]): Promise<void> {
    const now = new Map(panes.flatMap((pane) => {
      const session = pane.agent === "hermes" ? hermesSessionId(pane) : null;
      return session ? [[pane.pane_id, session] as const] : [];
    }));
    for (const paneId of this.sessions.keys()) if (!now.has(paneId)) this.set(paneId, { running: 0, since: null });
    this.sessions.clear();
    for (const [paneId, session] of now) this.sessions.set(paneId, session);
    const discovery = this.stores.refresh(panes);
    this.poll();
    await discovery;
    this.poll();
  }

  poll(only?: string): void {
    for (const [paneId, session] of this.sessions) {
      if (only !== undefined && only !== paneId) continue;
      const path = this.stores.path(paneId, session);
      this.set(paneId, path ? hermesDelegations(path, session) : { running: 0, since: null });
    }
  }

  private set(paneId: string, { running, since }: { running: number; since: number | null }): void {
    if ((this.counts.get(paneId) ?? 0) === running) return;
    if (running === 0) this.counts.delete(paneId); else this.counts.set(paneId, running);
    this.deps.onChange(paneId, running, since);
  }
}
