import type { ApiClient } from "./client";
import type { FetchLike } from "./http";
import { createHttpApi } from "./http-client";

export type { ApiClient } from "./client";
export { ApiError } from "./http";

/** The client the app uses: the real backend (`/api/health`, `/api/app/*`). */
export function createApiClient(options: { fetch?: FetchLike } = {}): ApiClient {
  return createHttpApi(options.fetch);
}
