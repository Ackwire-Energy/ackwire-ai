import type { MockedApi } from "../client";
import { createMockArtifacts } from "./artifacts";
import type { MockContext } from "./context";
import { createMockCustomConnectors } from "./custom-connectors";
import { createMockInvites } from "./misc";
import { createMockPlanning } from "./planning";
import { createMockStorage } from "./storage";

export type { MockContext } from "./context";

/** MOCK: every feature of the client that has no backend endpoint yet. */
export function createMockApi(ctx: MockContext, origin: () => string = () => window.location.origin): MockedApi {
  return {
    invites: createMockInvites(ctx, origin),
    storage: createMockStorage(),
    artifacts: createMockArtifacts(ctx),
    ...createMockPlanning(ctx),
    customConnectors: createMockCustomConnectors(ctx),
  };
}
