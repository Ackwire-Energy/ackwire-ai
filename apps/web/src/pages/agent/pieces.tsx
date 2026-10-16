import { Chip, Icon } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useChannels, useDms } from "@/api/queries";
import type { Channel, Run } from "@/api/types";
import { AgentSpinner } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import type { Field } from "@/lib/agent-edit";
import { useAgentEdit } from "./context";

/**
 * Who edits here, for those who can't edit everything: members read; the
 * owner (responsável) changes the look, access, audience and computer.
 * `field`: only when that part is read-only for the viewer.
 */
export function ReadOnlyNote({ field }: { field?: Field }) {
  const { t } = useTranslation();
  const { viewer, g, ownerFirst, can } = useAgentEdit();
  if (viewer === "admin") return null;
  if (field && can(field)) return null;
  if (viewer === "owner") {
    if (field && field !== "instructions") return null;
    return (
      <p className="agp-readonly">
        <Icon name="person" size={16} />
        <span>
          {field === "instructions" ? t("agentPage.readOnly.ownerInstructions") : t("agentPage.readOnly.owner", g)}
        </span>
      </p>
    );
  }
  return (
    <p className="agp-readonly">
      <Icon name="info" size={16} />
      <span>
        {ownerFirst
          ? t("agentPage.readOnly.memberOwner", { ...g, owner: ownerFirst })
          : t("agentPage.readOnly.member", g)}
      </span>
    </p>
  );
}

/** "#eng", "Mensagem direta" or nothing. */
export function runWhere(t: TFunction, run: Pick<Run, "channelId">, channels: Channel[]) {
  const c = channels.find((x) => x.id === run.channelId);
  return c ? `#${c.name}` : t("agentPage.activity.direct");
}

export function RunIcon({ run }: { run: Pick<Run, "status"> }) {
  const failed = run.status === "failed";
  const waiting = run.status === "waiting_approval" || run.status === "waiting_input";
  return (
    <span className="agp-ib" data-tone={failed ? "bad" : waiting ? "warn" : undefined}>
      <Icon name={failed ? "alert" : waiting ? "lock" : "check"} size={14} />
    </span>
  );
}

/** The run's state as a chip (icon and word). */
export function RunChip({ run }: { run: Pick<Run, "status"> & Partial<Pick<Run, "agentId">> }) {
  const { t } = useTranslation();
  if (run.status === "failed") return <Chip icon="alert">{t("agentPage.activity.failed")}</Chip>;
  if (run.status === "waiting_approval" || run.status === "waiting_input")
    return (
      <Chip icon="lock" tone="waiting">
        {t("agentPage.activity.waiting")}
      </Chip>
    );
  if (run.status === "running" || run.status === "queued")
    return (
      <Chip icon="spinner" lead={run.agentId ? <AgentSpinner agentId={run.agentId} /> : undefined}>
        {t("agentPage.activity.running")}
      </Chip>
    );
  if (run.status === "canceled") return <Chip icon="stop">{t("agentPage.activity.canceled")}</Chip>;
  return <Chip icon="check">{t("agentPage.activity.done")}</Chip>;
}

/** Channels the viewer can pick for the agent: every channel they see, without DMs. */
export function useVisibleChannels() {
  const { org } = useOrg();
  const channels = useChannels(org.id);
  const dms = useDms(org.id);
  const dmIds = new Set((dms.data ?? []).map((d) => d.channelId));
  return {
    list: (channels.data ?? []).filter((c) => !dmIds.has(c.id)),
    ready: channels.isSuccess && !dms.isPending,
  };
}
