import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hermesDelegations, HermesDelegations, hermesSessionId } from "./hermes-delegations.ts";

const SID = "20261010_001436_0d8605";
let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "hermes-delegations-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const delegations = (): { path: string; add: (id: string, session: string, state: string, delivery: string, pid?: number | null) => void; db: Database } => {
  const path = join(dir, "state.db");
  const db = new Database(path);
  db.exec(`CREATE TABLE async_delegations (delegation_id TEXT PRIMARY KEY, origin_session TEXT NOT NULL, state TEXT NOT NULL,
    dispatched_at REAL NOT NULL, delivery_state TEXT NOT NULL DEFAULT 'pending', owner_pid INTEGER)`);
  let at = 1_790_000_000;
  return { path, db, add: (id, session, state, delivery, pid = process.pid) => {
    db.query("INSERT INTO async_delegations VALUES (?, ?, ?, ?, ?, ?)").run(id, session, state, at++, delivery, pid);
  } };
};

describe("Hermes's background subagents", () => {
  test("takes only a session herdr's Hermes integration reported", () => {
    expect(hermesSessionId({ agent_session: { agent: "hermes", source: "herdr:hermes", kind: "id", value: SID } } as never)).toBe(SID);
    expect(hermesSessionId({ agent_session: { agent: "hermes", source: "other", kind: "id", value: SID } } as never)).toBeNull();
    expect(hermesSessionId({ agent_session: { agent: "hermes", source: "herdr:hermes", kind: "id", value: "../x" } } as never)).toBeNull();
  });

  test("counts the session's delegations at work or with a result not yet handed back, of a live owner", () => {
    const { path, add, db } = delegations();
    add("a", SID, "running", "pending");
    add("b", SID, "stalling", "pending");
    add("c", SID, "completed", "pending");      // done; its result starts the next turn
    add("d", SID, "completed", "delivered");    // over
    add("e", SID, "unknown", "dropped");        // over
    add("f", "20261010_000000_aaaaaa", "running", "pending"); // another session's
    add("g", SID, "running", "pending", 2 ** 22 + 12345);     // its Hermes is gone
    expect(hermesDelegations(path, SID)).toEqual({ running: 3, since: 1_790_000_002 * 1000 });
    db.close();
    // no store, or an older Hermes with no such table: nothing to wait on
    expect(hermesDelegations(join(dir, "missing.db"), SID)).toEqual({ running: 0, since: null });
  });

  test("tells each change of a Hermes pane's count, and a pane that left Hermes counts nothing", () => {
    const { path, add, db } = delegations();
    const seen: Array<[string, number]> = [];
    const tracker = new HermesDelegations({ path: () => path, onChange: (paneId, running) => seen.push([paneId, running]) });
    const pane = (agent: string) => ({ pane_id: "w1:p1", agent, agent_session: { agent: "hermes", source: "herdr:hermes", kind: "id", value: SID } }) as never;
    tracker.refresh([pane("hermes")]);
    add("a", SID, "running", "pending");
    tracker.poll("w1:p1");
    tracker.poll();
    expect(tracker.countOf("w1:p1")).toBe(1);
    tracker.refresh([pane("claude")]);
    expect(seen).toEqual([["w1:p1", 1], ["w1:p1", 0]]);
    expect(tracker.countOf("w1:p1")).toBe(0);
    db.close();
  });
});
