import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hermesDelegationResults, hermesDelegations, HermesDelegations, hermesSessionId } from "./hermes-delegations.ts";

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

describe("Hermes delegation result cards", () => {
  let db: Database;
  const notice = "[ASYNC DELEGATION BATCH COMPLETE — deleg_test]\nConsolidated fictional result.";
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("CREATE TABLE async_delegations (delegation_id TEXT, origin_session TEXT, task_json TEXT, result_json TEXT)");
  });
  afterEach(() => db.close());
  const put = (task: unknown, result: unknown) => db.query("INSERT INTO async_delegations VALUES (?, ?, ?, ?)")
    .run("deleg_test", SID, JSON.stringify(task), JSON.stringify(result));

  test("maps every result, preserving indices, metrics, model fallback and the result limit", () => {
    put({ goal: "Fallback goal", goals: ["Inspect widgets", "Check widgets"], role: "reviewer", model: "batch-model" }, { results: [
      { task_index: 1, status: "completed", summary: "All checked", model: "child-model", duration_seconds: 1.25, api_calls: 4, tool_trace: [{}, {}], tokens: { input: 30, output: 12 } },
      { task_index: 0, status: "error", summary: "x".repeat(16001), tokens: 9 },
      { task_index: 2, status: "interrupted", summary: "Stopped" },
    ] });
    expect(hermesDelegationResults(db, SID, notice)).toEqual([
      { id: "deleg_test:1", title: "Check widgets", agent: "reviewer", model: "child-model", status: "completed", duration_ms: 1250, turns: 4, tool_calls: 2, tokens: 42, result: "All checked" },
      { id: "deleg_test:0", title: "Inspect widgets", agent: "reviewer", model: "batch-model", status: "failed", duration_ms: null, turns: null, tool_calls: null, tokens: 9, result: "x".repeat(16000), result_cut: true },
      { id: "deleg_test:2", title: "Fallback goal", agent: "reviewer", model: "batch-model", status: "cancelled", duration_ms: null, turns: null, tool_calls: null, tokens: null, result: "Stopped" },
    ]);
  });

  test("maps all terminal states and does not turn malformed metrics into numbers", () => {
    const states = ["completed", "error", "failed", "timeout", "interrupted", "cancelled"];
    put({ goal: "Check" }, { results: states.map((status, task_index) => ({ task_index, status, summary: "Done", duration_seconds: "3", api_calls: "2", tool_trace: {}, tokens: { input: "5" } })) });
    const tasks = hermesDelegationResults(db, SID, notice)!;
    expect(tasks.map(task => task.status)).toEqual(["completed", "failed", "failed", "failed", "cancelled", "cancelled"]);
    expect(tasks[0]).toMatchObject({ agent: null, model: null, duration_ms: null, turns: null, tool_calls: null, tokens: null });
  });

  test("keeps plain text for absent, foreign, malformed or unknown results", () => {
    expect(hermesDelegationResults(db, SID, notice)).toBeNull();
    put({ goal: "Check" }, { results: [{ task_index: 0, status: "completed", summary: "Done" }] });
    expect(hermesDelegationResults(db, "another-session", notice)).toBeNull();
    expect(hermesDelegationResults(db, SID, `Quoted: ${notice}`)).toBeNull();
    for (const value of ["broken", "null", "[]", "{}", '{"results":[]}', '{"results":[null]}', '{"results":[{"task_index":0,"status":"running","summary":"Wait"}]}']) {
      db.query("UPDATE async_delegations SET result_json = ?").run(value);
      expect(hermesDelegationResults(db, SID, notice)).toBeNull();
    }
    db.query("UPDATE async_delegations SET task_json = ?, result_json = ?").run("broken", '{"results":[{"task_index":0,"status":"completed","summary":"Done"}]}');
    expect(hermesDelegationResults(db, SID, notice)).toBeNull();
    db.exec("DROP TABLE async_delegations");
    expect(hermesDelegationResults(db, SID, notice)).toBeNull();
  });
});

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
