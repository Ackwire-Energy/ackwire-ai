import { Stack } from "expo-router";
import { useRememberAgentLooks } from "@/features/shared/hooks";
import { useUserEvents } from "@/features/shared/userEvents";
import { coverBarOptions, useFormSheetOptions, usePushedOptions, useScrollUnderPushedOptions, useTheme } from "@/ui";

/** A link straight to a pushed screen or a sheet still has the tabs under it (the back button works). */
export const unstable_settings = { anchor: "(tabs)" };

/**
 * The signed-in app: the native tabs, and the screens pushed over them with the platform's push (the tab
 * bar hides there; the native back button and the edge swipe go back). Requests and Você are native form
 * sheets over whatever is on screen; Busca is a native modal. Header options are set here so the first
 * frame of a push already has its bar; `PushedHeader` fills in the title and actions.
 */
export default function AppLayout() {
  const { colors } = useTheme();
  useUserEvents();
  useRememberAgentLooks();
  const pushed = usePushedOptions();
  const scrollUnder = useScrollUnderPushedOptions();
  const approvalSheet = useFormSheetOptions([0.62, 1], "raised");
  const meSheet = useFormSheetOptions([0.7, 1]);
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, gestureEnabled: true }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="chat/[channelId]" options={pushed} />
      <Stack.Screen name="mission/[id]" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="agent/[id]" options={{ ...pushed, ...coverBarOptions }} />
      <Stack.Screen name="account-delete" options={{ ...pushed, ...scrollUnder }} />
      <Stack.Screen name="approval/[id]" options={approvalSheet} />
      <Stack.Screen name="me" options={meSheet} />
      <Stack.Screen name="search" options={{ presentation: "modal", contentStyle: { backgroundColor: colors.bg } }} />
    </Stack>
  );
}
