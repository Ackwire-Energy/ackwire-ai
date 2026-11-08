import { serverHost } from "@agenteschat/client/lib/server";
import { useTranslation } from "react-i18next";
import { setServer, useServer, useServerToReturn } from "@/lib/server";
import { router } from "@/ui/navigation";
import { AuthLink } from "./AuthLink";

/**
 * "Servidor: agentes.chat · Trocar": where this sign-in goes, and the way to another server. Signed in on another
 * server (this one added from Workspaces, ADR 0154): "Voltar para …" goes back to it, still signed in there.
 */
export function ServerLine() {
  const { t } = useTranslation();
  const server = useServer();
  const back = useServerToReturn();
  return (
    <>
      <AuthLink
        lead={t("mobile.auth.server.line", { host: serverHost(server) })}
        label={t("mobile.auth.server.change")}
        onPress={() => router.push("/server")}
      />
      {back ? (
        <AuthLink
          label={t("mobile.auth.server.backTo", { host: serverHost(back) })}
          onPress={() => void setServer(back)}
        />
      ) : null}
    </>
  );
}
