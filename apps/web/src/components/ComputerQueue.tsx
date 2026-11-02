import type { Message, ComputerQueue as Queue, QueueWhere } from "@agenteschat/client";
import { useChannels, useDms, useMachineQueue, useMachines } from "@agenteschat/client";
import {
  durationText,
  fanChipText,
  fanOutOf,
  fanOutText,
  type QueueNames,
  type QueuePlace,
  queueAllStartedText,
  queueButtonText,
  queueLeftText,
  queueLiveText,
  queuePurposeText,
  queueStartText,
  queueStatusText,
  queueView,
  queueWhereText,
} from "@agenteschat/client/lib/computer-queue";
import { Button, Chip, Dialog, DialogBody, useNow } from "@agenteschat/ui";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useLive } from "@/realtime/context";
import "./computer-queue.css";

/**
 * A shared computer's line (ADR 0032, "Calm waits"): the dialog every member can open in place, the waiting agent's
 * row under the message it answers, the strip under a message that called several agents, and the conversation
 * header's button while anyone waits. Every time is an estimate ("~N min").
 */

/** The computer an agent runs on, from the computers list (every member reads it). */
export function useAgentMachineId(agentId: string | null | undefined) {
  const { org } = useOrg();
  const machines = useMachines(org.id, Boolean(agentId));
  return machines.data?.find((m) => m.agents.some((a) => a.id === agentId))?.id ?? null;
}

/** The computer most of these agents share (a channel's agents nearly always share one). */
export function useAgentsMachineId(agentIds: readonly string[]) {
  const { org } = useOrg();
  const machines = useMachines(org.id, agentIds.length > 0);
  // ponytail: one computer per conversation; a channel whose agents split over several shows the busiest share only.
  let best: { id: string; n: number } | null = null;
  for (const m of machines.data ?? []) {
    const n = m.agents.filter((a) => agentIds.includes(a.id)).length;
    if (n > 0 && (!best || n > best.n)) best = { id: m.id, n };
  }
  return best?.id ?? null;
}

function useQueueNames(): QueueNames & { place: (w: QueueWhere) => QueuePlace } {
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const channels = useChannels(org.id);
  const dms = useDms(org.id);
  return {
    viewerId: me.user.id,
    agent: (id) => dir.agentById.get(id)?.name,
    person: (id) => dir.memberById.get(id)?.name,
    place: (w) => {
      const channel = channels.data?.find((c) => c.id === w.channelId);
      if (channel) return { kind: "channel", name: channel.name, thread: w.threadId !== null };
      if (dms.data?.some((d) => d.channelId === w.channelId)) return { kind: "dm", mine: true };
      return { kind: "hidden" };
    },
  };
}

/** "See queue": a link-like button that opens the computer's line over the conversation. */
export function SeeQueue({ machineId }: { machineId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="cq-link" onClick={() => setOpen(true)}>
        {t("queue.see")}
      </button>
      {open && <QueueDialog machineId={machineId} open={open} onOpenChange={setOpen} />}
    </>
  );
}

/** The computer's line: how full it is, every turn working on it, and the order of the rest. */
export function QueueDialog({
  machineId,
  open,
  onOpenChange,
}: {
  machineId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const q = useMachineQueue(org.id, machineId, open);
  const names = useQueueNames();
  // Elapsed times and estimates move on while it is open.
  const now = useNow(open ? 1000 : false);
  const queue = q.data;
  const name = queue?.name ?? t("queue.buttonIdle");
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        <>
          <span aria-hidden="true">{name}</span>
          <span className="ac-visually-hidden">{t("queue.label", { name })}</span>
        </>
      }
      closeLabel={t("common.close")}
      width={440}
      className="cq-dialog"
      subtitle={queue ? queueStatusText(t, queueView(queue, names.viewerId), now) : undefined}
    >
      <DialogBody>{queue && <QueueLists queue={queue} names={names} now={now} />}</DialogBody>
    </Dialog>
  );
}

function QueueLists({ queue, names, now }: { queue: Queue; names: ReturnType<typeof useQueueNames>; now: number }) {
  const { t } = useTranslation();
  const view = queueView(queue, names.viewerId);
  const allStarted = queueAllStartedText(t, view, now);
  const agentName = (id: string) => names.agent(id) ?? t("channel.unknownAgent");
  return (
    <div className="cq">
      <section className="cq__group">
        <h3 className="cq__title">
          <span>{t("queue.workingNow", { n: view.working.length })}</span>
        </h3>
        {view.working.length === 0 && <p className="cq__empty">{t("queue.nothingWorking")}</p>}
        <ol className="cq__rows">
          {view.working.map((w) => (
            <li key={w.runId} className="cq__row" data-mine={w.mine || undefined}>
              <span className="cq__n" />
              <AgentAvatar agentId={w.agentId} name={agentName(w.agentId)} size="xs" state="thinking" />
              <span className="cq__text">
                <b>{agentName(w.agentId)}</b>{" "}
                <span>
                  {[
                    queuePurposeText(t, w.purpose, names),
                    queueWhereText(t, names.place(w.where)),
                    durationText(t, Math.max(0, now - Date.parse(w.startedAt))),
                  ].join(" · ")}
                </span>
              </span>
              <span className="cq__time">{queueLeftText(t, w, now)}</span>
            </li>
          ))}
        </ol>
      </section>
      {view.waiting.length > 0 && (
        <section className="cq__group">
          <h3 className="cq__title">
            <span>{t("queue.inLine", { n: view.waiting.length })}</span>
            {allStarted && <span className="cq__all">{allStarted}</span>}
          </h3>
          <ol className="cq__rows">
            {view.waiting.map((w) => (
              <li key={w.runId} className="cq__row" data-mine={w.mine || undefined}>
                <span className="cq__n">{w.position}</span>
                <AgentAvatar agentId={w.agentId} name={agentName(w.agentId)} size="xs" state="idle" />
                <span className="cq__text">
                  <b>{agentName(w.agentId)}</b>{" "}
                  <span>
                    {[queuePurposeText(t, w.purpose, names), queueWhereText(t, names.place(w.where))].join(" · ")}
                  </span>
                  {w.mine && w.people && <Chip className="cq-first">{t("queue.youFirst")}</Chip>}
                </span>
                <span className="cq__time">{queueStartText(t, w, names.agent, now)}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <p className="cq__rule">{t("queue.rule")}</p>
    </div>
  );
}

/**
 * Under the message an agent waits to answer, in place of "in line for the computer": where it is in line and who
 * is ahead ("In line, 4th. After Ada, Kai and Ravi"), "You go first" when the viewer asked, and "See queue". Falls
 * back to `fallback` until the line says where the run is.
 */
export function QueueLiveRow({
  agentId,
  runId,
  fallback,
}: {
  agentId: string;
  runId: string | undefined;
  fallback: string;
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const machineId = useAgentMachineId(agentId);
  const q = useMachineQueue(org.id, machineId);
  const now = useNow(30_000);
  const agentName = (id: string) => dir.agentById.get(id)?.name;
  const text = runId ? queueLiveText(t, i18n.language, q.data, runId, agentName, now) : null;
  const row = runId ? q.data?.waiting.find((w) => w.runId === runId) : undefined;
  const first = row?.people && row.purpose.kind === "person" && row.purpose.userId === me.user.id;
  const name = agentName(agentId) ?? t("channel.unknownAgent");
  return (
    <span className="cq-live">
      <AgentAvatar agentId={agentId} name={name} size="xs" state="idle" />
      <span className="cq-live__text">
        {text ? (
          <>
            <b>{name}</b> · {text}
          </>
        ) : (
          fallback
        )}
      </span>
      {first && <Chip className="cq-first">{t("queue.youFirst")}</Chip>}
      {machineId && text && <SeeQueue machineId={machineId} />}
    </span>
  );
}

/**
 * Under a message that called several agents, once two or more started: "12 agents called · 2 answered · 2 working ·
 * 8 in line" and a chip per agent, live. `otherwise` (the receipt's own line) before that, and once every one is done.
 */
export function FanOutStrip({ message, otherwise = null }: { message: Message; otherwise?: ReactNode }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const receipt = useLive((s) => s.receipts[message.id]);
  const plain = fanOutOf(receipt);
  const open = plain?.agents.filter((a) => a.state === "working" || a.state === "inLine") ?? [];
  const machineId = useAgentMachineId(open[0]?.agentId);
  const q = useMachineQueue(org.id, machineId, open.length > 0);
  const fan = fanOutOf(receipt, q.data);
  const started = fan?.agents.filter((a) => receipt?.runOf?.[a.agentId]).length ?? 0;
  if (!fan || started < 2 || open.length === 0) return otherwise;
  return (
    <section className="cq-fan" aria-label={fanOutText(t, fan)}>
      <p className="cq-fan__head">
        <span>{fanOutText(t, fan)}</span>
        {machineId && <SeeQueue machineId={machineId} />}
      </p>
      <ul className="cq-fan__chips">
        {fan.agents.map((a) => {
          const name = dir.agentById.get(a.agentId)?.name ?? t("channel.unknownAgent");
          return (
            <li key={a.agentId}>
              <Chip
                className="cq-fan__chip"
                data-state={a.state}
                lead={<AgentAvatar agentId={a.agentId} name={name} size="xs" state="idle" />}
              >
                {name} <small>{fanChipText(t, i18n.language, a)}</small>
              </Chip>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The conversation header's button while anyone waits for this computer: "Computer · 9 waiting", opening the line. */
export function QueueButton({ machineId }: { machineId: string | null }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const q = useMachineQueue(org.id, machineId);
  const [open, setOpen] = useState(false);
  if (!machineId) return null;
  return (
    <>
      {q.data?.waiting.length ? (
        <Button size="sm" icon="computer" onClick={() => setOpen(true)}>
          {queueButtonText(t, q.data)}
        </Button>
      ) : null}
      {/* Stays open as the line empties: the person sees it end. */}
      {open && <QueueDialog machineId={machineId} open={open} onOpenChange={setOpen} />}
    </>
  );
}
