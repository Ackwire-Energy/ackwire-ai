import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useMemo } from "react";
import { authClient, readCookie } from "@/lib/auth";

export interface SessionState {
  /** Signed in (a session from the server or SecureStore's cache). */
  signedIn: boolean;
  /** Still checking (first launch, no cache yet). */
  pending: boolean;
  user: { id: string; name: string; email: string } | null;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

/**
 * The Better Auth session (cached in SecureStore by the Expo plugin, so a signed-in person opens the app
 * straight into it). When it ends, cached server data is dropped.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const session = authClient.useSession();
  const queryClient = useQueryClient();
  const user = session.data?.user ?? null;
  const signedIn = Boolean(user);

  useEffect(() => {
    if (signedIn) {
      // Whatever was cached while signed out (e.g. `me` = null) is stale now.
      void readCookie().then(() => queryClient.invalidateQueries());
    } else queryClient.clear();
  }, [signedIn, queryClient]);

  const value = useMemo<SessionState>(
    () => ({
      signedIn,
      pending: session.isPending && !user,
      user: user ? { id: user.id, name: user.name, email: user.email } : null,
      refresh: () => session.refetch(),
    }),
    [signedIn, session.isPending, user, session.refetch],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** The session gate's state (`app/_layout.tsx` sends signed-out people to `(auth)`). */
export function useSession(): SessionState {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession must be used inside SessionProvider");
  return s;
}
