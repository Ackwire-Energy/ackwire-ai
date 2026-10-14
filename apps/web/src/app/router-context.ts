import type { QueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";

/** What route guards (`beforeLoad`) get from the router. */
export interface RouterContext {
  queryClient: QueryClient;
  api: ApiClient;
}
