import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { keys } from "../src/api/keys";
import { applyWorkspaceEvent } from "../src/realtime/machines";

test("someone left: open apps read the people again, and the agents whose owner or brain changed", () => {
  const qc = new QueryClient();
  for (const key of [keys.people("o1"), keys.agents("o1"), keys.agentDetail("o1", "a1"), keys.agentDetail("o1", "a2")])
    qc.setQueryData(key, []);
  expect(applyWorkspaceEvent(qc, "o1", { type: "org.members", agents: ["a1"] } as { type: string })).toBe(true);
  const stale = (key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated;
  expect(stale(keys.people("o1"))).toBe(true);
  expect(stale(keys.agents("o1"))).toBe(true);
  expect(stale(keys.agentDetail("o1", "a1"))).toBe(true);
  expect(stale(keys.agentDetail("o1", "a2"))).toBe(false);
});

test("a role given or taken: the channel list is read again, since roles decide which channels are listed", () => {
  const qc = new QueryClient();
  qc.setQueryData(keys.channels("o1"), []);
  applyWorkspaceEvent(qc, "o1", { type: "org.members" });
  expect(qc.getQueryState(keys.channels("o1"))?.isInvalidated).toBe(true);
});
