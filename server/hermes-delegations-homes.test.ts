import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane } from "../shared/protocol.ts";
import { HermesDelegations } from "./hermes-delegations.ts";
import * as client from "./herdr/client.ts";

const SID = "fictional-session";
const pane = (id: string, session = SID) => ({ pane_id: id, agent: "hermes", agent_session: { agent: "hermes", source: "herdr:hermes", kind: "id", value: session } }) as HerdrPane;
let dir = "";
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });

function store(home: string, count: number): string {
  mkdirSync(home, { recursive: true });
  const path = join(home, "state.db");
  const db = new Database(path);
  try {
    db.exec("CREATE TABLE async_delegations (origin_session TEXT, state TEXT, delivery_state TEXT, owner_pid INTEGER, dispatched_at REAL)");
    for (let i = 0; i < count; i++) db.query("INSERT INTO async_delegations VALUES (?, 'running', 'pending', ?, ?)").run(SID, process.pid, 1_790_000_000 + i);
  } finally { db.close(); }
  return path;
}

test.skipIf(process.platform !== "linux" && process.platform !== "darwin")("counts each pane's own home when session ids collide, caches discovery and forgets departed panes", async () => {
  dir = mkdtempSync(join(tmpdir(), "hermes-delegation-homes-"));
  const profile = join(dir, "profile");
  store(dir, 1);
  store(profile, 2);
  const children = [dir, profile].map((home) => Bun.spawn([process.execPath, "-e", "console.log('ready'); for await (const _ of Bun.stdin.stream()) {}"], { env: { ...process.env, HERMES_HOME: home }, stdin: "pipe", stdout: "pipe" }));
  const panes = [pane("%default"), pane("%profile")];
  const rpc = spyOn(client, "herdrRpc").mockImplementation(async (_method: string, params: Record<string, unknown>) => ({ process_info: { foreground_processes: [{ pid: children[params?.["pane_id"] === "%profile" ? 1 : 0]!.pid, name: "hermes", argv: ["hermes"] }] } }) as never);
  const previous = process.env["HERMES_HOME"];
  process.env["HERMES_HOME"] = dir;
  try {
    await Promise.all(children.map((child) => child.stdout.getReader().read()));
    const tracker = new HermesDelegations({ onChange: () => {} });
    await tracker.refresh(panes);
    expect(tracker.countOf("%default")).toBe(1);
    expect(tracker.countOf("%profile")).toBe(2);
    await tracker.refresh(panes);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith("pane.process_info", { pane_id: "%profile" });
    await tracker.refresh([panes[0]!]);
    expect(tracker.countOf("%profile")).toBe(0);
    await tracker.refresh(panes);
    expect(tracker.countOf("%profile")).toBe(2);
    expect(rpc).toHaveBeenCalledTimes(3);
    await tracker.refresh([{ ...panes[1]!, agent: "shell" } as never]);
    expect(tracker.countOf("%profile")).toBe(0);
    expect(tracker.countOf("%default")).toBe(0);
  } finally {
    rpc.mockRestore();
    if (previous === undefined) delete process.env["HERMES_HOME"]; else process.env["HERMES_HOME"] = previous;
    children.forEach((child) => child.kill());
    await Promise.all(children.map((child) => child.exited));
  }
});

test("counts zero until discovery finishes and ignores late discovery for a departed pane", async () => {
  dir = mkdtempSync(join(tmpdir(), "hermes-delegation-discovery-"));
  const path = store(dir, 2);
  let resolve!: (path: string) => void;
  const pending = new Promise<string>((done) => { resolve = done; });
  const seen: number[] = [];
  const tracker = new HermesDelegations({ path: () => pending, onChange: (_id, count) => seen.push(count) });
  const discovering = tracker.refresh([pane("%waiting")]);
  tracker.poll();
  expect(tracker.countOf("%waiting")).toBe(0);
  expect(seen).toEqual([]);
  resolve(path);
  await discovering;
  expect(tracker.countOf("%waiting")).toBe(2);
  expect(seen).toEqual([2]);

  let finish!: (path: string) => void;
  const late = new HermesDelegations({ path: () => new Promise<string>((done) => { finish = done; }), onChange: () => {} });
  const gone = late.refresh([pane("%gone")]);
  await late.refresh([]);
  finish(path);
  await gone;
  late.poll();
  expect(late.countOf("%gone")).toBe(0);
});
