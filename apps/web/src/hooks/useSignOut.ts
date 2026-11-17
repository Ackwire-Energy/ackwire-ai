import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { AuthClient } from "@/auth/client";
import { useAuth } from "@/auth/context";
import { STORAGE_KEYS, storage } from "@/lib/storage";

/**
 * Out of the account because the person said so: the session ends (one the server never answered about ends here all
 * the same), this browser is marked as signed out by hand, so the server the desktop app runs here waits for its
 * owner's click instead of signing them in again at once (`AuthPage`), and nothing cached of the session stays.
 */
export async function signOutByHand(auth: AuthClient, qc: QueryClient) {
  await auth.signOut().catch(() => {});
  storage.set(STORAGE_KEYS.signedOut, "1");
  qc.clear();
}

/** Sair, wherever it is offered: `signOutByHand`, then the sign-in. */
export function useSignOut() {
  const auth = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const signOut = async () => {
    setPending(true);
    try {
      await signOutByHand(auth, qc);
      await navigate({ to: "/login" });
    } finally {
      setPending(false);
    }
  };
  return { signOut, pending };
}
