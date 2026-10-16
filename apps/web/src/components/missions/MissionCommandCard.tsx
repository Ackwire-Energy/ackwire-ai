import { Button, Chip, Icon, Skeleton } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useMission, useMissionAct, useMissionCommands } from "@/api/missions";
import type { MissionCommandMeta } from "@/api/types";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { errorText } from "@/lib/errors";
import { formatTime } from "@/lib/format";
import { executorName } from "@/lib/missions";
import { useToast } from "@/lib/toast";
import "./missions.css";

/**
 * The command card (ADR 0029): the executor asks to run a command off its
 * allow list ("Claude Code quer rodar: `swift build`"). The owner or someone
 * who decides answers Aprovar / Recusar / Aprovar sempre nesta missão; the
 * waiting executor gets the answer within seconds. Merges, pushes to the
 * default branch and deploys never come here (they need `request_approval`).
 */
export function MissionCommandCard({ command: meta }: { command: MissionCommandMeta }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const mission = useMission(org.id, meta.missionId);
  const commands = useMissionCommands(org.id, meta.missionId);
  const decide = useMissionAct(org.id, meta.missionId, (decision: "allow" | "deny" | "always") =>
    api.missions.decideCommand(org.id, meta.missionId, meta.id, decision),
  );
  const m = mission.data;
  const c = commands.data?.commands.find((x) => x.id === meta.id);
  if (!m || !c) {
    return mission.isPending || commands.isPending ? (
      <div className="mi-card mi-cmd" aria-hidden="true">
        <Skeleton width="60%" height={18} />
      </div>
    ) : null;
  }
  const who = executorName(m.executor === "codex" ? "codex" : "claude");
  const answer = (decision: "allow" | "deny" | "always") =>
    decide.mutate(decision, { onError: (e) => toast.show(errorText(t, e), "error") });
  const by = c.decidedBy ? (dir.memberById.get(c.decidedBy)?.name ?? t("missions.someone")) : "";
  const time = c.decidedAt ? formatTime(i18n.language, c.decidedAt) : "";
  return (
    <section className="mi-card mi-cmd" aria-label={t("missions.command.label", { executor: who })}>
      <div className="mi-tags">
        <Chip icon="code">{t("missions.command.cap", { executor: who })}</Chip>
        {c.state !== "pending" && (
          <Chip icon={c.state === "allowed" ? "check" : c.state === "expired" ? "clock" : "close"}>
            {t(`missions.command.state.${c.state}`)}
          </Chip>
        )}
      </div>
      <pre className="mi-cmd__line">
        <code>{c.command}</code>
      </pre>
      {c.state === "pending" ? (
        m.canAct ? (
          <div className="mi-foot">
            <Button variant="primary" size="sm" icon="check" loading={decide.isPending} onClick={() => answer("allow")}>
              {t("missions.command.allow")}
            </Button>
            <Button size="sm" icon="close" disabled={decide.isPending} onClick={() => answer("deny")}>
              {t("missions.command.deny")}
            </Button>
            {c.rules.length > 0 && (
              <Button size="sm" variant="ghost" disabled={decide.isPending} onClick={() => answer("always")}>
                {t("missions.command.always")}
              </Button>
            )}
          </div>
        ) : (
          <p className="mi-hint">{t("missions.command.waiting")}</p>
        )
      ) : (
        <p className="mi-hint">
          {c.state === "expired"
            ? t("missions.command.expired")
            : c.always
              ? t("missions.command.alwaysBy", { name: by, time, rules: c.rules.map(ruleText).join(", ") })
              : t(c.state === "allowed" ? "missions.command.allowedBy" : "missions.command.deniedBy", {
                  name: by,
                  time,
                })}
        </p>
      )}
      {c.state === "pending" && c.rules.length > 0 && m.canAct && (
        <p className="mi-hint">
          <Icon name="info" size={14} />
          {t("missions.command.alwaysHint", { rules: c.rules.map(ruleText).join(", ") })}
        </p>
      )}
    </section>
  );
}

/** `Bash(swift build *)` → `swift build …` (what people read). */
export const ruleText = (rule: string) => {
  const m = /^Bash\((.*)\)$/.exec(rule);
  if (m) return (m[1] ?? "").replace(/ \*$/, " …");
  const d = /^WebFetch\(domain:(.+)\)$/.exec(rule);
  return d ? (d[1] ?? rule) : rule;
};

/**
 * Under a task's end notice: the commands it was refused with nobody to ask
 * ("Bloqueado: `swift build`"); "Liberar e repetir" allows it for the
 * mission and resumes the session to try again (owner or deciders).
 */
export function BlockedCommands({
  missionId,
  taskId,
  blocked,
}: {
  missionId: string;
  taskId: string;
  blocked: { tool: string; command: string }[];
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const toast = useToast();
  const mission = useMission(org.id, missionId);
  const retry = useMissionAct(org.id, missionId, (command: string) =>
    api.missions.retryCommand(org.id, missionId, { taskId, command }),
  );
  const canAct = Boolean(mission.data?.canAct && mission.data.status === "active");
  return (
    <ul className="mi-cmd-blocked" aria-label={t("missions.command.blockedLabel")}>
      {blocked.map((d) => (
        <li key={`${d.tool}:${d.command}`}>
          <Icon name="lock" size={14} />
          <span className="mi-cmd-blocked__t">
            {t("missions.command.blocked")} <code className="mi-mono">{d.command}</code>
          </span>
          {canAct && (
            <Button
              size="sm"
              icon="refresh"
              loading={retry.isPending && retry.variables === d.command}
              disabled={retry.isPending}
              onClick={() =>
                retry.mutate(d.command, {
                  onSuccess: (out) =>
                    toast.show(
                      out.delivered ? t("missions.command.retried") : t("missions.command.retryQueued"),
                      "info",
                    ),
                  onError: (e) => toast.show(errorText(t, e), "error"),
                })
              }
            >
              {t("missions.command.retry")}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
