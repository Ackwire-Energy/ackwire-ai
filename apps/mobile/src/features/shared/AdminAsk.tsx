import { type AdminAsk, type AppNotification, useAddChannelMember, useAskAdmins } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { useTranslation } from "react-i18next";
import { Button, GroupedList, GroupedRow, useToast } from "@/ui";
import { useOrgId } from "./hooks";

/** "Pedir a um admin" as a row (the web's button): sent to whoever may do it (`admin_ask`), and said so. */
export function AskAdminRow({ ask }: { ask: AdminAsk }) {
  const { t } = useTranslation();
  const toast = useToast();
  const send = useAskAdmins(useOrgId());
  return (
    <GroupedList>
      <GroupedRow
        icon="send"
        label={t("adminAsk.ask")}
        disabled={send.isPending || send.isSuccess}
        onPress={() =>
          send.mutate(ask, {
            onSuccess: () => toast({ title: t("adminAsk.sent"), icon: "check" }),
            onError: (e) => toast({ title: errorText(t, e), icon: "x" }),
          })
        }
      />
    </GroupedList>
  );
}

/** Under an inbox row asking to add an agent to a channel: Adicionar ao canal, right here (the row then resolves). */
export function AdminAskAdd({ n }: { n: AppNotification }) {
  const { t } = useTranslation();
  const toast = useToast();
  const add = useAddChannelMember(useOrgId());
  const { channelId, agentId } = n.source;
  if (n.latest.reason !== "channel_agent" || !channelId || !agentId || n.doneAt) return null;
  return (
    <Button
      variant="secondary"
      size="sm"
      label={t("mentions.add")}
      disabled={add.isPending}
      onPress={() =>
        add.mutate(
          { channelId, member: { agentId } },
          { onError: (err) => toast({ title: errorText(t, err), icon: "x" }) },
        )
      }
    />
  );
}
