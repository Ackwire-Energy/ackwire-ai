import type { ApiClient } from "./client";
import type { FetchLike } from "./http";
import { createHttpApi } from "./http-client";
import { createMockApi } from "./mock";

export type { ApiClient } from "./client";
export { ApiError } from "./http";

/**
 * The client the app uses: real HTTP for what the backend exposes, in-memory
 * mocks (src/api/mock) for the rest. Seeds demo data only in development.
 */
export function createApiClient(options: { fetch?: FetchLike; seed?: boolean; now?: () => Date } = {}): ApiClient {
  const http = createHttpApi(options.fetch);
  const mocks = createMockApi({
    seed: options.seed ?? false,
    now: options.now ?? (() => new Date()),
    lookup: {
      me: () => http.account.me(),
      agents: (orgId) => http.agents.list(orgId),
      channels: (orgId) => http.chat.channels(orgId),
      members: (orgId) => http.orgs.members(orgId),
    },
  });
  return { ...http, ...mocks };
}
