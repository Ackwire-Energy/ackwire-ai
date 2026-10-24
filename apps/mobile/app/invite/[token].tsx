import { useLocalSearchParams } from "expo-router";
import { InviteScreen } from "@/features/auth/InviteScreen";
import { isInviteToken } from "@/features/auth/links";
import { ResetPasswordScreen } from "@/features/auth/ResetPasswordScreen";

/** `https://agentes.chat/invite/{token}` opened in the app (D88), signed in or not. */
export default function InviteRoute() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  // A malformed link reads like an expired one (the screen offers the way back).
  return isInviteToken(token) ? <InviteScreen token={token} /> : <ResetPasswordScreen token={null} />;
}
