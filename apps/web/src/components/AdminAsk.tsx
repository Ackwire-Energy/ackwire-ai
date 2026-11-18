import { type AdminAsk, type AppNotification, useAddChannelMember, useAskAdmins } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { Button, type ButtonProps } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";

/** "Pedir a um admin": sends the ask to whoever may do it (`admin_ask`), and says so. */
export function AskAdminButton({
  ask,
  size = "sm",
  ...rest
}: { ask: AdminAsk } & Pick<ButtonProps, "size" | "variant">) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const send = useAskAdmins(org.id);
  return (
    <Button
      size={size}
      icon="arrowUp"
      {...rest}
      loading={send.isPending}
      disabled={send.isPending || send.isSuccess}
      onClick={() =>
        send.mutate(ask, {
          onSuccess: () => toast.show(t("adminAsk.sent")),
          onError: (e) => toast.show(errorText(t, e), "error"),
        })
      }
    >
      {t("adminAsk.ask")}
    </Button>
  );
}

/** An ask to add an agent to a channel, done in the inbox row ("Adicionar ao canal"); the row resolves itself. */
export function AdminAskActions({ n, inline = false }: { n: AppNotification; inline?: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const add = useAddChannelMember(org.id);
  const { channelId, agentId } = n.source;
  if (n.kind !== "admin_ask" || n.latest.reason !== "channel_agent" || !channelId || !agentId || n.doneAt) return null;
  const button = (
    <Button
      size="sm"
      variant="primary"
      loading={add.isPending}
      disabled={add.isPending}
      onClick={(e) => {
        e.stopPropagation();
        add.mutate({ channelId, member: { agentId } }, { onError: (err) => toast.show(errorText(t, err), "error") });
      }}
    >
      {t("mentions.add")}
    </Button>
  );
  return inline ? button : <div className="nt-steprow ac-acts">{button}</div>;
}
