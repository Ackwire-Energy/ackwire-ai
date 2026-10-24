import { ThemeProvider as NavigationThemeProvider, Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { keys, useApi } from "@agenteschat/client";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Entering } from "@/features/auth/Entering";
import { forgetInvite, loadPendingInvite } from "@/features/auth/invite";
import { OnboardingFlow } from "@/features/onboarding/OnboardingFlow";
import { AppProviders } from "@/providers/AppProviders";
import { useAppFonts } from "@/providers/fonts";
import { useOrgGate } from "@/providers/org";
import { useSession } from "@/providers/session";
import { useNavigationTheme } from "@/ui/navigation";
import { useTheme } from "@/ui/theme";

void SplashScreen.preventAutoHideAsync().catch(() => {});

/** Root: the providers, then the session gate. */
export default function RootLayout() {
  return (
    <AppProviders>
      <Gate />
    </AppProviders>
  );
}

/**
 * Signed out → `(auth)`; signed in → `(app)` (the screens, which wait for the organization themselves). The
 * splash stays up until the fonts, the session and the organization are known, so nobody sees a flash of the
 * wrong side. Exactly one group is open at any moment: with both guarded (e.g. signed in while the
 * organization still loads), expo-router sends the guarded screen to the first open route, `+not-found`, and
 * the app would stay there once the organization arrived.
 */
function Gate() {
  const fontsReady = useAppFonts();
  const session = useSession();
  const org = useOrgGate();
  const { colors, scheme } = useTheme();
  const navigationTheme = useNavigationTheme();
  const signedIn = session.signedIn;
  const ready = fontsReady && !session.pending && (!signedIn || !org.loading);

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  // Just signed in (not a cold start already signed in): "Entrando…" for a moment while the app fills in.
  const [entering, setEntering] = useState(false);
  const wasSignedIn = useRef<boolean | null>(null);
  useEffect(() => {
    if (session.pending) return;
    const before = wasSignedIn.current;
    wasSignedIn.current = signedIn;
    if (before !== false || !signedIn) return;
    setEntering(true);
    const timer = setTimeout(() => setEntering(false), 1400);
    return () => clearTimeout(timer);
  }, [signedIn, session.pending]);
  const accepting = useAcceptPendingInvite(signedIn && !session.pending);

  // The navigator is always mounted (so links and pushes can navigate); the splash covers it until ready.
  return (
    // The native bars (headers, back button tint, interface style) read React Navigation's theme: ours.
    <NavigationThemeProvider value={navigationTheme}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Protected guard={signedIn}>
          <Stack.Screen name="(app)" />
        </Stack.Protected>
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="(auth)" />
        </Stack.Protected>
      </Stack>
      {/* Signed in with no workspace yet: the first run (an invitation waiting is accepted instead). */}
      {ready && signedIn && org.none && !accepting ? <OnboardingFlow /> : null}
      {entering ? <Entering org={org.state?.org?.name ?? null} /> : null}
    </NavigationThemeProvider>
  );
}

/**
 * An invitation opened before signing in (features/auth/invite.ts): accepted as soon as the person is in, and
 * its organization becomes the current one. True while it is being accepted (the first run waits).
 */
function useAcceptPendingInvite(signedIn: boolean): boolean {
  const api = useApi();
  const qc = useQueryClient();
  const org = useOrgGate();
  const [accepting, setAccepting] = useState(false);
  const choose = org.choose;
  useEffect(() => {
    if (!signedIn) return;
    let alive = true;
    void loadPendingInvite().then(async (token) => {
      if (!token || !alive) return;
      setAccepting(true);
      try {
        const { orgId } = await api.orgs.acceptInvitation(token);
        await qc.invalidateQueries({ queryKey: keys.me });
        choose(orgId);
      } catch {
        // Expired, used or for another e-mail: the invitation's own screen says why when it is opened again.
      } finally {
        forgetInvite();
        if (alive) setAccepting(false);
      }
    });
    return () => {
      alive = false;
    };
  }, [signedIn, api, qc, choose]);
  return accepting;
}
