import { ThemeProvider as NavigationThemeProvider, Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { AppProviders } from "@/providers/AppProviders";
import { useAppFonts } from "@/providers/fonts";
import { useOrgGate } from "@/providers/org";
import { useSession } from "@/providers/session";
import { NoOrganization } from "@/ui/auth/NoOrganization";
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
 * Signed out → `(auth)`; signed in with an organization → `(app)` (the screens). The splash stays up
 * until the fonts, the session and the organization are known, so nobody sees a flash of the wrong side.
 */
function Gate() {
  const fontsReady = useAppFonts();
  const session = useSession();
  const org = useOrgGate();
  const { colors, scheme } = useTheme();
  const navigationTheme = useNavigationTheme();
  const signedIn = session.signedIn;
  const hasOrg = signedIn && Boolean(org.state);
  const ready = fontsReady && !session.pending && (!signedIn || !org.loading);

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  // The navigator is always mounted (so links and pushes can navigate); the splash covers it until ready.
  return (
    // The native bars (headers, back button tint, interface style) read React Navigation's theme: ours.
    <NavigationThemeProvider value={navigationTheme}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Protected guard={hasOrg}>
          <Stack.Screen name="(app)" />
        </Stack.Protected>
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="(auth)" />
        </Stack.Protected>
      </Stack>
      {ready && signedIn && org.none ? <NoOrganization /> : null}
    </NavigationThemeProvider>
  );
}
