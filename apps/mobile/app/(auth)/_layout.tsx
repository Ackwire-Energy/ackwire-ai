import { Stack } from "expo-router";
import { useTheme } from "@/ui/theme";

/** Sign in, sign up and forgot password: one question per screen, slide between them. */
export default function AuthLayout() {
  const { colors } = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg },
        animation: "slide_from_right",
      }}
    />
  );
}
