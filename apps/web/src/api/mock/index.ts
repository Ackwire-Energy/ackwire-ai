import type { MockedApi } from "../client";
import { createMockApprovals } from "./approvals";
import type { MockContext } from "./context";
import { createMockMemory } from "./memory";
import { createMockInvites, createMockPresence } from "./misc";
import { createMockPermissions } from "./permissions";
import { createMockProposals } from "./proposals";
import { createMockRuns } from "./runs";

export type { MockContext } from "./context";

/** MOCK: every feature of the client that has no backend endpoint yet. */
export function createMockApi(ctx: MockContext, origin: () => string = () => window.location.origin): MockedApi {
  return {
    approvals: createMockApprovals(ctx),
    permissions: createMockPermissions(ctx),
    runs: createMockRuns(ctx),
    memory: createMockMemory(ctx),
    proposals: createMockProposals(ctx),
    invites: createMockInvites(ctx, origin),
    presence: createMockPresence(ctx),
  };
}
