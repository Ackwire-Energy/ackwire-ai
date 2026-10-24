import {
  agentWaitingPhrase,
  type ComputerBrain,
  type MoveResultLike,
  moveOutcome,
  namesParts,
  type OutageAgentLike,
  type OutageLike,
  type OutageTargetLike,
  outageNotice,
  type TargetOption,
  type WaitCardState,
} from "@agenteschat/client/lib/machine-outages";
import { computerKind } from "@agenteschat/client/lib/machines";
import type { TFunction } from "i18next";

/**
 * "Computador desconectado" on the phone: the words of the notice under
 * the greeting, the agents' rows, the "Trocar o computador" sheet, its toast and the chat's waiting card.
 * Pure: the screens turn these into views; the counts and the targets come from
 * `@agenteschat/client/lib/machine-outages`.
 */

// ── The API (mobile-local until the shared client has it; see queries.ts) ──

export interface MachineOutageAgent {
  agentId: string;
  name: string;
  brain: ComputerBrain;
  waiting: { routines: number; conversations: number };
}
export interface MachineOutage {
  machineId: string;
  name: string;
  platform: string;
  /** The workspace's own computer (ADR 0056 §10). */
  managed?: boolean;
  offlineSince: string;
  agents: MachineOutageAgent[];
  waitingRuns: number;
}
export type MachineOutageTarget = OutageTargetLike;
/** `GET …/machines/outages`. */
export interface MachineOutages {
  outages: MachineOutage[];
  targets: MachineOutageTarget[];
}
/** `POST …/machines/{machineId}/move-agents`. */
export interface MoveAgentsResult {
  moved: string[];
  skipped: { agentId: string; reason: string }[];
  resumed: number;
  stillWaiting: number;
}

/** How often the outages are asked again while one shows. */
export const OUTAGES_POLL_MS = 30_000;

/** The brains' product names (not translated). */
export const BRAIN_NAME: Record<ComputerBrain, string> = { claude_code: "Claude Code", codex: "Codex" };

// ── Words ───────────────────────────────────────────────────────────────────

/** "Ada", "Ada e Theo", "Ada, Theo e mais 2". */
export function namesText(t: TFunction, names: readonly string[]): string {
  const p = namesParts(names);
  if (!p.second) return p.first;
  return p.more > 0
    ? t("mobile.names.more", { first: p.first, second: p.second, count: p.more })
    : t("mobile.names.two", { first: p.first, second: p.second });
}

/** The notice: "O MacBook Air desconectou" and "Ada e Theo esperam por ele · 3 tarefas". */
export function noticeText(t: TFunction, o: OutageLike) {
  const n = outageNotice(o);
  const names = o.agents.map((a) => a.name);
  const who =
    names.length === 1
      ? t("mobile.outage.whoOne", { name: names[0] })
      : t("mobile.outage.whoMany", { names: namesText(t, names) });
  const sub = n.tasks > 0 ? `${who} · ${t("mobile.outage.tasks", { count: n.tasks })}` : who;
  return { title: t("mobile.outage.title", { computer: n.computer }), sub };
}

/** "2 rotinas esperando", "1 conversa esperando", "3 tarefas esperando" (or "Nada esperando"). */
export function waitingText(t: TFunction, a: Pick<OutageAgentLike, "waiting">): string {
  const p = agentWaitingPhrase(a);
  return p ? t(`mobile.outage.waiting.${p.kind}`, { count: p.count }) : t("mobile.outage.waiting.none");
}

/** The sheet's line under its title: who passes to work where. */
export function sheetDesc(t: TFunction, o: OutageLike, agentIds: ReadonlySet<string>) {
  const names = o.agents.filter((a) => agentIds.has(a.agentId)).map((a) => a.name);
  const shown = names.length > 0 ? names : o.agents.map((a) => a.name);
  return t(shown.length === 1 ? "mobile.outage.sheet.descOne" : "mobile.outage.sheet.descMany", {
    computer: o.name,
    names: namesText(t, shown),
  });
}

/** The icon of a target or a computer: by its platform, the cloud one for the cloud. */
export function computerIcon(platform: string | null | undefined, cloud = false) {
  const kind = computerKind(platform, cloud);
  return kind === "mac"
    ? "computerMac"
    : kind === "windows"
      ? "computerWindows"
      : kind === "cloud"
        ? "computerCloud"
        : "computerLinux";
}

/** A target row: its title, the tag next to it ("Ligado", "Sempre ligado") and the line under it. */
export function targetText(t: TFunction, x: TargetOption) {
  const title = x.kind === "cloud" ? t("mobile.outage.sheet.cloud") : (x.name ?? "");
  if (!x.enabled) {
    const brain = x.missing ? BRAIN_NAME[x.missing] : x.brains[0] ? BRAIN_NAME[x.brains[0]] : BRAIN_NAME.claude_code;
    const reason = x.reason ?? "other";
    return {
      title,
      tag: null,
      desc: t(`mobile.outage.sheet.reason.${reason}`, {
        brain,
        defaultValue: t("mobile.outage.sheet.reason.other"),
      }),
    };
  }
  if (x.kind === "cloud")
    return { title, tag: t("mobile.outage.sheet.cloudTag"), desc: t("mobile.outage.sheet.cloudDesc") };
  // The workspace's own computer: always on, a user of its own for each agent.
  if (x.managed) return { title, tag: t("mobile.outage.sheet.cloudTag"), desc: t("mobile.outage.sheet.managedDesc") };
  const brains = x.brains.map((b) => BRAIN_NAME[b]).join(t("mobile.outage.sheet.and"));
  return {
    title,
    tag: t("mobile.outage.sheet.on"),
    desc: brains ? t("mobile.outage.sheet.has", { brains }) : "",
  };
}

/** The toast after "Trocar": how many switched, then what resumed, what still waits and who couldn't. */
export function moveToast(t: TFunction, r: MoveResultLike, computer: string) {
  const o = moveOutcome(r);
  const parts = [
    o.resumed > 0 ? t("mobile.outage.result.resumed", { count: o.resumed }) : null,
    o.stillWaiting > 0 ? t("mobile.outage.result.still", { count: o.stillWaiting, computer }) : null,
    o.skipped > 0 && o.moved > 0 ? t("mobile.outage.result.skipped", { count: o.skipped }) : null,
  ].filter((x): x is string => Boolean(x));
  return {
    title: o.moved > 0 ? t("mobile.outage.result.done", { count: o.moved }) : t("mobile.outage.result.none"),
    subtitle: o.moved > 0 ? parts.join(" · ") || undefined : undefined,
    ok: o.moved > 0,
  };
}

/** The waiting card in the chat: its title and line, and whether it is settled (back or moved). */
export function waitCardText(
  t: TFunction,
  state: WaitCardState,
  brain: ComputerBrain,
  computerName: string | null,
): { title: string; body: string; done: boolean } | null {
  if (state.kind === "unknown") return null;
  if (state.kind === "back")
    return {
      title: computerName ? t("mobile.outage.card.back", { computer: computerName }) : t("mobile.outage.card.backSome"),
      body: t("mobile.outage.card.backBody"),
      done: true,
    };
  if (state.kind === "moved")
    return {
      title: t("mobile.outage.card.moved"),
      body: t("mobile.outage.card.movedBody", { computer: state.computer }),
      done: true,
    };
  const line = t("mobile.outage.card.body", { brain: BRAIN_NAME[brain] });
  const p = state.waiting ? agentWaitingPhrase(state.waiting) : null;
  return {
    title: t("mobile.outage.card.waiting", { computer: state.computer }),
    body: p ? `${line} · ${t(`mobile.outage.waiting.${p.kind}`, { count: p.count })}` : `${line}.`,
    done: false,
  };
}
