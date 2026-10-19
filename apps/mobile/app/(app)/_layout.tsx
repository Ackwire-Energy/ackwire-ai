import { Stack } from "expo-router";
import { View } from "react-native";
import { useRememberAgentLooks } from "@/features/shared/hooks";
import { useUserEvents } from "@/features/shared/userEvents";
import { useOrgGate } from "@/providers/org";
import { coverBarOptions, useFormSheetOptions, usePushedOptions, useScrollUnderPushedOptions, useTheme } from "@/ui";

/** A link straight to a pushed screen or a sheet still has the tabs under it (the back button works). */
export const unstable_settings = { anchor: "(tabs)" };

/**
 * The signed-in app: the native tabs, and the screens pushed over them with the platform's push (the tab
 * bar hides there; the native back button and the edge swipe go back). Requests, Você and "Novo" (the "+"
 * of the tabs, with its three forms stacked over it) are native form sheets over whatever is on screen.
 * Header options are set here so the first frame of a push already has its bar; `PushedHeader` fills in
 * the title and actions.
 */
export default function AppLayout() {
  const { colors } = useTheme();
  const org = useOrgGate();
  // Signed in, the organization not known yet (the splash covers this) or none (`NoOrganization` covers it):
  // the screens need one, so they mount once it's chosen, at the URL the app opened with.
  if (!org.state) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  return <AppStack />;
}

function AppStack() {
  const { colors } = useTheme();
  useUserEvents();
  useRememberAgentLooks();
  const pushed = usePushedOptions();
  const scrollUnder = useScrollUnderPushedOptions();
  const approvalSheet = useFormSheetOptions([0.62, 1], "raised");
  const meSheet = useFormSheetOptions([0.7, 1]);
  const newSheet = useFormSheetOptions([0.6, 1]);
  const formSheet = useFormSheetOptions([1]);
  const channelSheet = useFormSheetOptions([0.45, 1]);
  const switchSheet = useFormSheetOptions([0.8, 1]);
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, gestureEnabled: true }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="chat/[channelId]" options={pushed} />
      <Stack.Screen name="conversations/[kind]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="mission/[id]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="agent/[id]" options={{ ...pushed, ...coverBarOptions }} />
      <Stack.Screen name="account-delete" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="issues/index" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="issues/[id]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="issues/new" options={formSheet} />
      <Stack.Screen name="drive/index" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="approval/[id]" options={approvalSheet} />
      <Stack.Screen name="switch-computer/[machineId]" options={switchSheet} />
      <Stack.Screen name="me" options={meSheet} />
      <Stack.Screen name="new" options={newSheet} />
      <Stack.Screen name="new-agent" options={formSheet} />
      <Stack.Screen name="new-channel" options={channelSheet} />
      <Stack.Screen name="new-chat" options={formSheet} />
      <Stack.Screen
        name="images"
        options={{
          presentation: "transparentModal",
          animation: "fade",
          contentStyle: { backgroundColor: "transparent" },
        }}
      />
      {/* A bare link to a browser request: finds its conversation and replaces itself with it. */}
      <Stack.Screen name="handoff/[id]" options={{ animation: "none", contentStyle: { backgroundColor: colors.bg } }} />
      <Stack.Screen
        name="file/[id]"
        options={{ presentation: "fullScreenModal", contentStyle: { backgroundColor: colors.bg } }}
      />
    </Stack>
  );
}
