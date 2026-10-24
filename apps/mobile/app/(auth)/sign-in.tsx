import { useLocalSearchParams } from "expo-router";
import { AuthFlow } from "@/features/auth/AuthFlow";

/** Entrar: the e-mail first, then the one step the server says it needs (telas/EntrarCadastro.html, C). */
export default function SignIn() {
  // From an invitation ("Já tenho conta"): its e-mail, straight to the password.
  const params = useLocalSearchParams<{ email?: string }>();
  return <AuthFlow start="in" email={typeof params.email === "string" ? params.email : undefined} />;
}
