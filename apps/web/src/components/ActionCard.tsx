import type { Message } from "@agenteschat/client";
import { useAiStatus } from "@agenteschat/client";
import { actionCardOf, connectAiDone } from "@agenteschat/client/lib/action-cards";
import { joinNames } from "@agenteschat/client/lib/format";
import { Button, Chip, Icon } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useConnectAi } from "@/components/ConnectAi";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";

/**
 * An agent's action card (ADR 0061, `meta.actionCard`) in place of its text: what needs a person's
 * credentials or consent, one click away. "Conectar uma IA" opens the Connect dialog at the card's step for
 * the agents it names (the dialog says what each person may do), and reads "Conectado" once they can think.
 */
export function ActionCard({ message }: { message: Message }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const status = useAiStatus(org.id);
  const connect = useConnectAi();
  const card = actionCardOf(message.meta);
  if (!card) return null;
  const done = connectAiDone(card, status.data, dir.agentById);
  const agents = joinNames(
    card.agentIds.map((id) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent")),
    t("newAgent.and"),
  );
  const title = agents
    ? t("actionCard.connect_ai.title", { context: card.what, agents })
    : t(`connectAi.title.${card.what ?? "any"}`);
  return (
    <div className="waitcard" data-done={done || undefined}>
      <span className="waitcard__top ac-iconline">
        <Icon name={done ? "check" : "plug"} size={16} />
        <span>{title}</span>
      </span>
      {card.why && <p>{card.why}</p>}
      {done ? (
        <span className="waitcard__acts">
          <Chip icon="check" tone="done">
            {t("actionCard.connected")}
          </Chip>
        </span>
      ) : (
        connect && (
          <span className="waitcard__acts">
            <Button
              size="sm"
              onClick={() =>
                connect.open({
                  intent: card.what,
                  provider: card.provider,
                  agentIds: card.agentIds,
                  agentId: card.agentIds[0],
                })
              }
            >
              {t("actionCard.connect")}
            </Button>
          </span>
        )
      )}
    </div>
  );
}
