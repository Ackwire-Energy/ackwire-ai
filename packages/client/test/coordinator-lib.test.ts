import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { keys } from "../src/api/keys";
import { applyWorkspaceEvent } from "../src/realtime/machines";

describe("the team's coordinator (ADR 0092)", () => {
  test("another agent coordinating, or none: every open app reads the agents again", () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.agents("o1"), []);
    expect(applyWorkspaceEvent(qc, "o1", { type: "agent.coordinator" })).toBe(true);
    expect(qc.getQueryState(keys.agents("o1"))?.isInvalidated).toBe(true);
  });
});
