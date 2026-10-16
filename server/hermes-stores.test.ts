import { expect, setSystemTime, test } from "bun:test";

import type { HerdrPane } from "../shared/protocol.ts";
import { HermesStores } from "./hermes-stores.ts";
import { hermesDbPath } from "./hermes.ts";

const pane = { pane_id: "%1", agent: "hermes", agent_session: { agent: "hermes", source: "herdr:hermes", kind: "id", value: "20260101_000000_abcdef" } } as HerdrPane;

test("keeps a pane's known store while it is looked up again", async () => {
  let answer: (path: string) => void = () => undefined;
  let calls = 0;
  const stores = new HermesStores(() => {
    calls += 1;
    return calls === 1 ? "/fake/one/state.db" : new Promise<string>((resolve) => { answer = resolve; });
  });
  try {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    await stores.ensure(pane);
    expect(stores.path("%1", "20260101_000000_abcdef")).toBe("/fake/one/state.db");

    setSystemTime(new Date("2026-01-01T00:01:00Z")); // past the 30 s rediscovery interval
    const again = stores.ensure(pane);
    expect(calls).toBe(2);
    expect(stores.path("%1", "20260101_000000_abcdef")).toBe("/fake/one/state.db");
    answer("/fake/two/state.db");
    await again;
    expect(stores.path("%1", "20260101_000000_abcdef")).toBe("/fake/two/state.db");
  } finally {
    setSystemTime();
  }
});

test("keeps a profile pane's store when a later lookup can only answer the default store", async () => {
  const answers = ["/fake/profile/state.db", hermesDbPath(), "/fake/profile/state.db"];
  const stores = new HermesStores(() => answers.shift()!);
  const at = (minute: number) => setSystemTime(new Date(`2026-01-01T00:0${minute}:00Z`));
  try {
    at(0);
    await stores.ensure(pane);
    at(1); // the pane's process could not be read: the lookup fell back to the default store
    await stores.ensure(pane);
    expect(stores.path("%1", "20260101_000000_abcdef")).toBe("/fake/profile/state.db");
    at(2);
    await stores.ensure(pane);
    expect(stores.path("%1", "20260101_000000_abcdef")).toBe("/fake/profile/state.db");
  } finally {
    setSystemTime();
  }
});
