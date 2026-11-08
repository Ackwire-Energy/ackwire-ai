import { serverHost } from "@agenteschat/client/lib/server";
import { useTranslation } from "react-i18next";
import { useServer } from "@/lib/server";
import { router } from "@/ui/navigation";
import { AuthLink } from "./AuthLink";

/** "Servidor: agentes.chat · Trocar": where this sign-in goes, and the way to another server. */
export function ServerLine() {
  const { t } = useTranslation();
  const server = useServer();
  return (
    <AuthLink
      lead={t("mobile.auth.server.line", { host: serverHost(server) })}
      label={t("mobile.auth.server.change")}
      onPress={() => router.push("/server")}
    />
  );
}
