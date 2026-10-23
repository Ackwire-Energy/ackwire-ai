import { ApiError } from "@agenteschat/client";
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";

/**
 * Same policy as Tierbird's dashboard: queries show their errors inline; a
 * 401 anywhere means the session ended (back to sign-in); every failed write
 * gets a toast with the server's message.
 */
export function createQueryClient(handlers: {
  onUnauthorized: () => void;
  onMutationError: (message: string) => void;
  unknownError: () => string;
  /** A failed write in the person's language, for the server codes the app knows; null: the server's message. */
  describeError?: (error: unknown) => string | null;
}) {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
        refetchOnWindowFocus: false,
      },
    },
    queryCache: new QueryCache({
      onError: (error) => {
        if (error instanceof ApiError && error.status === 401) handlers.onUnauthorized();
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _vars, _ctx, mutation) => {
        if (error instanceof ApiError && error.status === 401) return handlers.onUnauthorized();
        // Mutations that show their own inline error opt out with `meta: { silent: true }`.
        if (mutation.meta?.silent) return;
        const known = handlers.describeError?.(error);
        if (known) return handlers.onMutationError(known);
        handlers.onMutationError(error instanceof Error && error.message ? error.message : handlers.unknownError());
      },
    }),
  });
}
