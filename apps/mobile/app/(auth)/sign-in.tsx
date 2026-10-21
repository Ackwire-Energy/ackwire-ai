import { AuthFlow } from "@/features/auth/AuthFlow";

/** Entrar: the e-mail first, then the one step the server says it needs (telas/EntrarCadastro.html, C). */
export default function SignIn() {
  return <AuthFlow start="in" />;
}
