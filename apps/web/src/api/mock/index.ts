import type { MockedApi } from "../client";
import type { MockContext } from "./context";
import { createMockMemory } from "./memory";
import { createMockInvites } from "./misc";
import { createMockProposals } from "./proposals";

export type { MockContext } from "./context";

/** MOCK: every feature of the client that has no backend endpoint yet. */
export function createMockApi(ctx: MockContext, origin: () => string = () => window.location.origin): MockedApi {
  return {
    memory: createMockMemory(ctx),
    proposals: createMockProposals(ctx),
    invites: createMockInvites(ctx, origin),
  };
}
