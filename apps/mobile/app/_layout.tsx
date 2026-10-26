import { keys, useApi } from "@agenteschat/client";
import { useQueryClient } from "@tanstack/react-query";
import { ThemeProvider as NavigationThemeProvider, router, Stack, usePathname } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Entering } from "@/features/auth/Entering";
import { forgetInvite, loadPendingInvite } from "@/features/auth/invite";
import { LaunchSplash } from "@/features/launch/LaunchSplash";
import { OnboardingFlow } from "@/features/onboarding/OnboardingFlow";
import { firstRunMounted, suspendedOf } from "@/lib/org-choice";
import { AppProviders } from "@/providers/AppProviders";
import { useAppFonts } from "@/providers/fonts";
import { useOrgGate } from "@/providers/org";
import { useSession } from "@/providers/session";
import { SuspendedWorkspace } from "@/ui/auth/SuspendedWorkspace";
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
 * splash (`LaunchSplash`) stays up until the fonts, the session and the organization are known, so nobody sees
 * a flash of the wrong side. Exactly one group is open at any moment: with both guarded (e.g. signed in while the
 * organization still loads), expo-router sends the guarded screen to the first open route, `+not-found`, and
 * the app would stay there once the organization arrived. While the session is still being read (the saved
 * one comes out of SecureStore a moment after launch) `(app)` is the open one, so the URL the app opened with
 * ("/", a push's conversation) is kept: closing it then sent "/" to `+not-found`, still on screen when the
 * session arrived ("Não achamos isso" on every launch). Each side sends a closed screen to the other's start.
 */
function Gate() {
  const fontsReady = useAppFonts();
  const session = useSession();
  const org = useOrgGate();
  const { colors, scheme } = useTheme();
  const navigationTheme = useNavigationTheme();
  const signedIn = session.signedIn;
  const inApp = signedIn || session.pending;
  const ready = fontsReady && !session.pending && (!signedIn || !org.loading);
  const suspended = ready && signedIn && org.state ? suspendedOf(org.state.orgs, org.state.orgId) : null;

  // Opening the app: the native launch image hands over to the animated splash on its first frame (they look
  // the same), which leaves once the app is ready. The fallback hide covers a splash that never lays out.
  const [launching, setLaunching] = useState(true);
  const hideNative = useCallback(() => void SplashScreen.hideAsync().catch(() => {}), []);
  const launched = useCallback(() => setLaunching(false), []);
  useEffect(() => {
    if (ready) hideNative();
  }, [ready, hideNative]);

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
  // An invitation's own screen stays in front of the first run: someone with no workspace yet may be joining one.
  const onInvite = usePathname().startsWith("/invite/");
  const [firstRunBefore, setFirstRunBefore] = useState(false);
  const firstRun = firstRunMounted(firstRunBefore, ready && signedIn && org.none && !accepting, onInvite);
  if (firstRun !== firstRunBefore) setFirstRunBefore(firstRun);

  // The navigator is always mounted (so links and pushes can navigate); the splash covers it until ready.
  return (
    // The native bars (headers, back button tint, interface style) read React Navigation's theme: ours.
    <NavigationThemeProvider value={navigationTheme}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      {/* Under the suspended screen the app stays mounted, out of screen readers' reach. */}
      <View
        style={{ flex: 1 }}
        accessibilityElementsHidden={suspended !== null}
        importantForAccessibility={suspended ? "no-hide-descendants" : "auto"}
      >
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
          <Stack.Protected guard={inApp} redirectTo="/sign-in">
            <Stack.Screen name="(app)" />
          </Stack.Protected>
          <Stack.Protected guard={!inApp} redirectTo="/">
            <Stack.Screen name="(auth)" />
          </Stack.Protected>
        </Stack>
      </View>
      {/* No workspace yet: the first run, over the navigator (a waiting invitation is accepted instead). */}
      {firstRun ? (
        <View style={onInvite ? { display: "none" } : StyleSheet.absoluteFill}>
          <OnboardingFlow />
        </View>
      ) : null}
      {entering ? <Entering org={org.state?.org?.name ?? null} /> : null}
      {org.state && suspended ? <SuspendedWorkspace state={org.state} suspended={suspended} /> : null}
      {launching ? <LaunchSplash ready={ready} fontsReady={fontsReady} onShown={hideNative} onDone={launched} /> : null}
    </NavigationThemeProvider>
  );
}

/**
 * An invitation opened before signing in (features/auth/invite.ts), once the person is in: an email invitation is
 * accepted and its organization becomes the current one; a link's page opens again, for the account to ask to
 * join. True while one is being accepted (the first run waits).
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
    void loadPendingInvite().then(async (next) => {
      if (!next || !alive) return;
      if ("open" in next) {
        forgetInvite();
        router.navigate(next.open);
        return;
      }
      setAccepting(true);
      try {
        const { orgId } = await api.orgs.acceptInvitation(next.accept);
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
