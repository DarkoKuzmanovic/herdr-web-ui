/** Hermes's todo snapshots, with pruned successful results rebuilt from their recorded calls. */
import { Database } from "bun:sqlite";

import type { HerdrPane, PlanStep } from "../shared/protocol.ts";
import { remember } from "./claude-subagents.ts";
import { hermesSessionId } from "./hermes-delegations.ts";
import { HermesStores } from "./hermes-stores.ts";

export interface HermesPlanRow {
  role: string;
  tool_name: string | null;
  content: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  active: number;
  compacted: number;
}

type ObjectRow = Record<string, unknown>;
type Todo = { id: string; content: string; status: string; parent?: string };
const object = (value: unknown): ObjectRow | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectRow : null;
const parse = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return null; }
};
const todoName = (name: unknown): boolean => name === "todo" || name === "todo_list";
const statuses = new Set(["pending", "in_progress", "completed", "cancelled"]);
const capContent = (text: string): string => text.length > 4000 ? `${text.slice(0, 4000 - "… [truncated]".length)}… [truncated]` : text;
const fullTodos = (result: ObjectRow | null): Todo[] | null => {
  const list = result?.["todos"];
  if (!result || "error" in result || !Array.isArray(list)) return null;
  return list.every((item) => { const t = object(item); return typeof t?.["id"] === "string" && typeof t["content"] === "string" && typeof t["status"] === "string" && statuses.has(t["status"]); }) ? list as Todo[] : null;
};

/** Only the list-changing semantics of TodoStore.write/_merge in Hermes's tools/todo_tool.py. */
function writeTodos(before: Todo[], input: unknown[], merge: boolean): Todo[] | null {
  const last = new Map<string, number>();
  input.forEach((value, index) => last.set(object(value) ? String(object(value)!["id"] ?? "").trim() || "?" : `__invalid_${index}`, index));
  const values = [...last.values()].sort((a, b) => a - b).map((index) => input[index]);
  let items = merge ? before.map((item) => ({ ...item })) : [];
  for (const value of values) {
    const row = object(value);
    const id = String(row?.["id"] ?? "").trim();
    if (merge && !id) continue;
    const current = merge ? items.find((item) => item.id === id) : undefined;
    if (current) {
      if (row?.["content"]) current.content = capContent(String(row["content"]).trim());
      const status = String(row?.["status"] ?? "").trim().toLowerCase();
      if (statuses.has(status)) current.status = status;
      if (row && "parent" in row) current.parent = String(row["parent"] || "").trim();
    } else if (!row) {
      items.push({ id: "?", content: "(invalid item)", status: "pending" });
    } else {
      const content = String(row["content"] ?? "").trim();
      if (!content) return null; // Hermes rejects the whole write, not just the invalid item
      const status = String(row["status"] ?? "pending").trim().toLowerCase();
      const parent = String(row["parent"] || "").trim();
      items.push({ id: id || "?", content: capContent(content), status: statuses.has(status) ? status : "pending", ...(parent && parent !== id ? { parent } : {}) });
    }
  }
  // Hermes preserves nested authored order, but lifts the first active step over pending roots.
  if (!items.some((item) => item.parent)) {
    const active = items.findIndex((item) => item.status === "in_progress");
    const pending = items.findIndex((item) => item.status === "pending");
    if (pending >= 0 && active > pending) items.splice(pending, 0, ...items.splice(active, 1));
  }
  items = items.slice(0, 256);
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const item of items) if (item.parent && !byId.has(item.parent)) delete item.parent;
  for (const item of items) {
    const seen = new Set([item.id]);
    let node = item;
    while (node.parent) {
      if (seen.has(node.parent)) { delete item.parent; break; }
      seen.add(node.parent);
      node = byId.get(node.parent)!;
    }
  }
  return items;
}

/** Rows are in id order; active and compacted history count, rewound history does not. */
export function parseHermesPlan(rows: readonly HermesPlanRow[]): PlanStep[] | null {
  const calls = new Map<string, ObjectRow>();
  let todos: Todo[] | null = null;
  for (const row of rows) {
    if (row.active !== 1 && row.compacted !== 1) continue;
    if (row.role === "assistant") {
      const entries = parse(row.tool_calls);
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const call = object(entry);
        const fn = object(call?.["function"]);
        if (!todoName(fn?.["name"])) continue;
        const args = object(parse(fn?.["arguments"]));
        if (args) for (const id of [call?.["id"], call?.["call_id"]]) if (typeof id === "string") calls.set(id, args);
      }
      continue;
    }
    if (row.role !== "tool" || !todoName(row.tool_name)) continue;
    const result = object(parse(row.content));
    if (result && "error" in result) continue;
    const full = fullTodos(result);
    if (full !== null) {
      todos = full.map((item) => ({ ...item }));
      continue;
    }
    if (!row.content || !/^(?:\[todo\] updated task list|\[tool_call\] )/.test(row.content)) continue;
    const args = row.tool_call_id ? calls.get(row.tool_call_id) : undefined;
    const input = parse(args?.["todos"]);
    if (Array.isArray(input)) todos = writeTodos(todos ?? [], input, args?.["merge"] === true) ?? todos;
  }
  return todos?.flatMap((item): PlanStep[] => item.status === "cancelled" ? [] : [{ id: item.id, label: item.content, status: item.status as PlanStep["status"], active: null, blocked_by: [], owner: null, started_at: null, ended_at: null }]) ?? null;
}

/** No open handles between polls; store discovery never blocks the synchronous reader. */
export class HermesPlans {
  private readonly cache = new Map<string, { signature: string; steps: PlanStep[] | null }>();
  private readonly stores: HermesStores;

  constructor(deps: { path?: (pane: HerdrPane) => string | Promise<string> } = {}) {
    this.stores = new HermesStores(deps.path);
  }

  refresh(panes: readonly HerdrPane[]): Promise<void> {
    return this.stores.refresh(panes);
  }

  ensure(pane: HerdrPane): Promise<void> {
    return this.stores.ensure(pane);
  }

  read(pane: HerdrPane): PlanStep[] | null {
    const session = pane.agent === "hermes" ? hermesSessionId(pane) : null;
    const path = session ? this.stores.path(pane.pane_id, session) : null;
    if (!session || !path) return null;
    let db: Database;
    try { db = new Database(path, { readonly: true, create: false }); } catch { return null; }
    try {
      db.exec("PRAGMA busy_timeout = 250");
      const signature = JSON.stringify(db.query(`SELECT count(*) AS count, max(id) AS newest, sum(active) AS active, sum(compacted) AS compacted FROM messages
        WHERE session_id = ? AND role = 'tool' AND tool_name IN ('todo', 'todo_list') AND (active = 1 OR compacted = 1)`).get(session));
      const key = `${path}\0${session}`;
      const cached = this.cache.get(key);
      if (cached?.signature === signature) return cached.steps;
      const results: HermesPlanRow[] = [];
      // shortcut: at most 200 results and 1 MiB of results/calls per change, upgrade if real plans exceed this window.
      let left = 1024 * 1024;
      const newest = db.query<HermesPlanRow & { bytes: number }, [number, string]>(`SELECT role, tool_name,
        CASE WHEN length(CAST(content AS BLOB)) <= ? THEN content END AS content,
        length(CAST(content AS BLOB)) AS bytes, tool_call_id, NULL AS tool_calls, active, compacted FROM messages
        WHERE session_id = ? AND role = 'tool' AND tool_name IN ('todo', 'todo_list') AND (active = 1 OR compacted = 1) ORDER BY id DESC LIMIT 200`);
      for (const row of newest.iterate(left, session)) {
        if (row.bytes > left) break;
        left -= row.bytes ?? 0;
        results.push(row);
        if (fullTodos(object(parse(row.content))) !== null) break;
      }
      results.reverse();
      const ids = [...new Set(results.filter((row) => /^(?:\[todo\] updated task list|\[tool_call\] )/.test(row.content ?? "")).flatMap((row) => row.tool_call_id ? [row.tool_call_id] : []))];
      const calls: HermesPlanRow[] = [];
      if (ids.length && left > 0) {
        const needed = db.query<{ call: string; bytes: number }, [number, string, string]>(`SELECT entry.value AS call, length(CAST(entry.value AS BLOB)) AS bytes
          FROM messages, json_each(CASE WHEN length(CAST(tool_calls AS BLOB)) <= ? AND json_valid(tool_calls) THEN tool_calls ELSE '[]' END) AS entry
          WHERE session_id = ? AND role = 'assistant' AND (active = 1 OR compacted = 1) AND entry.type = 'object'
            AND (json_extract(entry.value, '$.id') IN (SELECT value FROM json_each(?3))
              OR json_extract(entry.value, '$.call_id') IN (SELECT value FROM json_each(?3)))
          ORDER BY messages.id LIMIT 200`);
        for (const row of needed.iterate(left, session, JSON.stringify(ids))) {
          if (row.bytes > left) break;
          left -= row.bytes;
          calls.push({ role: "assistant", tool_name: null, content: null, tool_call_id: null, tool_calls: `[${row.call}]`, active: 1, compacted: 0 });
        }
      }
      const steps = parseHermesPlan([...calls, ...results]);
      remember(this.cache, key, { signature, steps }, 256);
      return steps;
    } catch {
      return null; // older schemas and busy or unavailable stores have no known plan
    } finally {
      db.close();
    }
  }
}
