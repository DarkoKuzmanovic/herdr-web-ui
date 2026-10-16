import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane } from "../shared/protocol.ts";
import { HermesPlans, parseHermesPlan, type HermesPlanRow } from "./hermes-plan.ts";

const item = (id: string, status = "pending", extra = {}) => ({ id, content: `Step ${id}`, status, ...extra });
const result = (todos: unknown[], extra = {}): HermesPlanRow => ({ role: "tool", tool_name: "todo_list", content: JSON.stringify({ todos }), tool_call_id: null, tool_calls: null, active: 1, compacted: 0, ...extra });
const stub = (todos: unknown, merge = false, name = "todo_list"): HermesPlanRow[] => [
  { ...result([]), role: "assistant", tool_name: null, tool_calls: JSON.stringify([{ call_id: "call-a", function: { name, arguments: JSON.stringify({ todos, merge }) } }]) },
  { ...result([]), tool_name: name, tool_call_id: "call-a", content: "[todo] updated task list" },
];
const progress = (rows: HermesPlanRow[]) => parseHermesPlan(rows)?.map((step) => `${step.id}:${step.status}`);

let dir = "";
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });

describe("Hermes plan", () => {
  test("the newest full result wins, with either tool name", () => {
    expect(progress([result([item("old")], { tool_name: "todo" }), result([item("new", "completed")])])).toEqual(["new:completed"]);
    expect(progress([result([item("old")]), result([item("new")], { tool_name: "todo" })])).toEqual(["new:pending"]);
  });

  test("replays merge and replace stubs, including string-encoded todos and both stub layouts", () => {
    const rows = [result([item("a"), item("b")]), ...stub([{ id: "a", status: "completed" }, item("c"), { content: "No id" }], true, "todo")];
    expect(progress(rows)).toEqual(["a:completed", "b:pending", "c:pending"]);
    const replacement = stub(JSON.stringify([item("d", "in_progress")]));
    replacement[1]!.content = '[tool_call] arguments={...} name=todo_list (604 chars result)';
    expect(progress([...rows, ...replacement])).toEqual(["d:in_progress"]);
    replacement[1]!.content = '[tool_call] name=todo_list arguments={...} (604 chars result)';
    expect(progress(replacement)).toEqual(["d:in_progress"]);
  });

  test("does not replay failed, malformed, unanswered or unrelated calls", () => {
    for (const content of ["Tool 'todo_list' failed", "Tool 'todo' failed", '{"error":"rejected"}', "unrecognized result", "{bad json}"]) {
      const rows = stub([item("wrong")]);
      rows[1]!.content = content;
      expect(progress([result([item("a")]), ...rows])).toEqual(["a:pending"]);
    }
    expect(parseHermesPlan(stub([item("a")]).slice(0, 1))).toBeNull();
    expect(parseHermesPlan([result([item("a")], { tool_name: "terminal" })])).toBeNull();
  });

  test("matches only successful results to recorded call ids, including compacted calls", () => {
    const rows = stub([item("a")]);
    rows[0]!.active = 0;
    rows[0]!.compacted = 1;
    rows[0]!.tool_calls = JSON.stringify([{ id: "call-a", function: { name: "todo_list", arguments: JSON.stringify({ todos: [item("a")] }) } }]);
    expect(progress(rows)).toEqual(["a:pending"]);
    rows[1]!.tool_call_id = "other-call";
    expect(parseHermesPlan(rows)).toBeNull();
    rows[1]!.tool_call_id = "call-a";
    rows[0]!.compacted = 0;
    expect(parseHermesPlan(rows)).toBeNull();
    expect(progress([result([item("a")]), result([item("wrong")], { content: JSON.stringify({ error: "rejected", todos: [item("wrong")] }) })])).toEqual(["a:pending"]);
    expect(progress([result([item("a")]), result([item("wrong", ["completed"] as never)])])).toEqual(["a:pending"]);
  });

  test("omits cancelled steps and flattens nested items in stored order", () => {
    expect(parseHermesPlan([result([item("parent", "completed"), item("child", "in_progress", { parent: "parent" }), item("cancel", "cancelled"), item("last")])])).toEqual([
      { id: "parent", label: "Step parent", status: "completed", active: null, owner: null, started_at: null, ended_at: null, blocked_by: [] },
      { id: "child", label: "Step child", status: "in_progress", active: null, owner: null, started_at: null, ended_at: null, blocked_by: [] },
      { id: "last", label: "Step last", status: "pending", active: null, owner: null, started_at: null, ended_at: null, blocked_by: [] },
    ]);
  });

  test("ignores rewound rows, counts compacted rows, and has no plan without parseable todos", () => {
    expect(progress([result([item("a")], { active: 0, compacted: 1 }), result([item("b")], { active: 0 })])).toEqual(["a:pending"]);
    expect(parseHermesPlan([])).toBeNull();
    expect(parseHermesPlan([result([], { content: "garbled" })])).toBeNull();
    expect(parseHermesPlan([result([])])).toEqual([]);
  });

  test("normalizes stub writes like Hermes: dedupe, defaults, active priority and partial merges", () => {
    expect(progress(stub([item("a"), item("b", "in_progress"), item("a", "completed")]))).toEqual(["b:in_progress", "a:completed"]);
    const rows = [result([item("a"), item("b")]), ...stub([{ id: "b", status: " IN_PROGRESS ", content: " Renamed " }, { id: "a", status: "invalid" }], true)];
    expect(progress(rows)).toEqual(["b:in_progress", "a:pending"]);
    expect(parseHermesPlan(rows)?.[0]?.label).toBe("Renamed");
    expect(progress([result([item("a")]), ...stub([{ id: "b" }])])).toEqual(["a:pending"]);
  });

  test("reads only the reported session, follows new rows and rewinds, and handles missing stores", () => {
    dir = mkdtempSync(join(tmpdir(), "hermes-plan-"));
    const path = join(dir, "state.db");
    const db = new Database(path);
    db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, tool_name TEXT, content TEXT, tool_calls TEXT, tool_call_id TEXT, active INTEGER, compacted INTEGER)");
    const add = (session: string, row: HermesPlanRow) => db.query("INSERT INTO messages (session_id, role, tool_name, content, tool_calls, tool_call_id, active, compacted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(session, row.role, row.tool_name, row.content, row.tool_calls, row.tool_call_id, row.active, row.compacted);
    const pane = { agent: "hermes", agent_session: { agent: "hermes", source: "herdr:hermes", kind: "id", value: "session-a" } } as HerdrPane;
    const plans = new HermesPlans({ path: () => path });
    try {
      add("session-a", result([item("a")]));
      add("session-b", result([item("private")]));
      expect(plans.read(pane)?.map((step) => step.id)).toEqual(["a"]);
      const cached = plans.read(pane);
      expect(plans.read(pane)).toBe(cached);
      for (const row of stub([{ id: "a", status: "completed" }], true)) add("session-a", row);
      expect(plans.read(pane)?.[0]?.status).toBe("completed");
      db.exec("UPDATE messages SET active = 0 WHERE id > 2");
      expect(plans.read(pane)?.[0]?.status).toBe("pending");
      expect(plans.read({ ...pane, agent: "shell" } as never)).toBeNull();
      expect(plans.read({ ...pane, agent_session: { ...pane.agent_session, source: "unknown" } } as never)).toBeNull();
    } finally { db.close(); }
    expect(new HermesPlans({ path: () => join(dir, "missing.db") }).read(pane)).toBeNull();
  });
});
