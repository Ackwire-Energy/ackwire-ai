import { Stack } from "expo-router";
import { useRememberAgentLooks } from "@/features/shared/hooks";
import { useUserEvents } from "@/features/shared/userEvents";
import { useTheme } from "@/ui";

/**
 * The signed-in app: the tabs, and the screens pushed over them (the tab bar
 * hides there; edge swipe goes back). Requests and Você open as sheets over
 * whatever is on screen; Busca is full-screen glass.
 */
export default function AppLayout() {
  const { colors } = useTheme();
  useUserEvents();
  useRememberAgentLooks();
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, gestureEnabled: true }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="chat/[channelId]" />
      <Stack.Screen name="mission/[id]" />
      <Stack.Screen name="agent/[id]" />
      <Stack.Screen name="account-delete" />
      <Stack.Screen
        name="approval/[id]"
        options={{
          presentation: "transparentModal",
          animation: "none",
          contentStyle: { backgroundColor: "transparent" },
        }}
      />
      <Stack.Screen
        name="me"
        options={{
          presentation: "transparentModal",
          animation: "none",
          contentStyle: { backgroundColor: "transparent" },
        }}
      />
      <Stack.Screen
        name="search"
        options={{
          presentation: "transparentModal",
          animation: "fade",
          contentStyle: { backgroundColor: "transparent" },
        }}
      />
    </Stack>
  );
}
