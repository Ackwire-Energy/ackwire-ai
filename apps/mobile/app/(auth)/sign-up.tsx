import { useLocalSearchParams } from "expo-router";
import { AuthFlow } from "@/features/auth/AuthFlow";

/** Criar conta: the same flow as Entrar, with a welcome for new people. */
export default function SignUp() {
  const params = useLocalSearchParams<{ email?: string }>();
  return <AuthFlow start="up" email={typeof params.email === "string" ? params.email : undefined} />;
}
