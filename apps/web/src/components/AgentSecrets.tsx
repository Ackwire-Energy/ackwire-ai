import { Button } from "@agenteschat/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { keys } from "@/api/keys";
import type { Agent } from "@/api/types";
import { useDirectory } from "@/hooks/useDirectory";
import { formatTime } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { useOrg } from "./org-context";

/**
 * Secrets people gave the agent's computer (ADR 0027): names, where they
 * went, who gave them and Remover. Values never leave the computer. Shown to
 * the agent's owner and admins, like the computer itself.
 */
export function AgentSecretsRow({ agent, editable }: { agent: Agent; editable: boolean }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const dir = useDirectory(org.id);
  const canManage = editable || (agent.ownerUserId != null && agent.ownerUserId === me.user.id);
  const list = useQuery({
    queryKey: keys.agentSecrets(org.id, agent.id),
    queryFn: () => api.secrets.list(org.id, agent.id),
    enabled: canManage,
  });
  const remove = useMutation({
    mutationFn: (s: { name: string; machineId: string | null }) =>
      api.secrets.remove(org.id, agent.id, s.name, s.machineId),
    meta: { silent: true },
    onSuccess: (_v, s) => {
      toast.show(t("agentSecrets.removed", { name: s.name }));
      void qc.invalidateQueries({ queryKey: keys.agentSecrets(org.id, agent.id) });
    },
    onError: () => toast.show(t("agentSecrets.removeFailed"), "error"),
  });
  // Nothing to show until someone gave it a secret (the agent asks in the chat when it needs one).
  if (!canManage || !list.data || list.data.length === 0) return null;
  const secrets = list.data;
  return (
    <section aria-labelledby="sec-secrets" className="summary-row">
      <div className="summary-row__text">
        <h2 id="sec-secrets" className="summary-row__title">
          {t("agentSecrets.title")}
        </h2>
        <div className="summary-row__body stack-4" style={{ gap: 8 }}>
          <span className="small muted">{t("agentSecrets.help")}</span>
          <ul className="agent-secrets">
            {secrets.map((s) => (
              <li key={`${s.machineId ?? "cloud"}:${s.name}`} className="agent-secrets__row">
                <span className="agent-secrets__name">
                  <code>{s.name}</code>
                  <span className="small muted">
                    {s.target.kind === "file" ? t("agentSecrets.file", { path: s.target.path }) : t("agentSecrets.env")}
                    {" · "}
                    {t("agentSecrets.by", {
                      person: dir.memberById.get(s.deliveredByUserId)?.name ?? t("channel.unknownPerson"),
                      time: formatTime(i18n.language, s.deliveredAt),
                    })}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  aria-label={t("agentSecrets.removeLabel", { name: s.name })}
                  loading={remove.isPending && remove.variables?.name === s.name}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate({ name: s.name, machineId: s.machineId })}
                >
                  {t("agentSecrets.remove")}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
