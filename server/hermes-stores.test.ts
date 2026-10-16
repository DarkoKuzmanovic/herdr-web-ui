import { expect, setSystemTime, test } from "bun:test";

import type { HerdrPane } from "../shared/protocol.ts";
import { HermesStores } from "./hermes-stores.ts";

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
