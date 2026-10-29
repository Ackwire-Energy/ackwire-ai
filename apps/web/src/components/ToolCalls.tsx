import { isScreenTool, type LiveWork, type ScreenKind, useCatalog, useRun } from "@agenteschat/client";
import type { ActivityKind } from "@agenteschat/client/lib/activity";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  formatDuration,
  formatLineTime,
  type ToolItem,
  type ToolLine,
  toolApps,
  toolCalls,
  toolItemsLive,
  toolItemsSaved,
  toolNow,
  toolPhrase,
  workFromSteps,
  workMeta,
} from "@agenteschat/client/lib/work";
import {
  type AgentColor,
  Icon,
  type IconName,
  PixelSpinner,
  ToolBlock,
  type ToolBlockItem,
  type ToolBlockLine,
} from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { CodePanel, formatBytes, OutputView, type SteerNote, SteerWell } from "@/components/LiveCode";
import { useOrg } from "@/components/org-context";

/** Our own tools by what they do: their icon in the block (a connector's call shows its logo). */
const KIND_ICON: Partial<Record<ActivityKind, IconName>> = {
  readingDrive: "drive",
  writingDrive: "drive",
  exportingFile: "drive",
  importingFile: "drive",
  uploadingArtifact: "drive",
  fetchingFile: "file",
  creatingIssue: "issues",
  updatingIssue: "issues",
  readingIssues: "issues",
  startingTask: "issues",
  listingTasks: "issues",
  checkingTask: "issues",
  cancelingTask: "issues",
  searchingMemory: "bulb",
  updatingMemory: "bulb",
  gettingContext: "bulb",
  checkingCalendar: "calendar",
  schedulingEvent: "calendar",
  schedulingReminder: "bell",
  cancelingReminder: "bell",
  listingReminders: "bell",
  creatingRoutine: "routines",
  updatingRoutine: "routines",
  listingRoutines: "routines",
  openingForumTopic: "message",
  postingInForum: "message",
  readingForum: "message",
  writingWiki: "book",
  readingWiki: "book",
  linkingWiki: "book",
  askingQuestion: "question",
  reacting: "smile",
  openingSkill: "layers",
  consultingSkill: "layers",
  runningSkillScript: "code",
  runningSkillScriptAny: "code",
  runningCode: "code",
  browsing: "globe",
  pcFiles: "file",
  checkingComputer: "computer",
  proposingMission: "flag",
  messagingMission: "flag",
  updatingPlan: "flag",
  reportingProgress: "flag",
  askingDecision: "flag",
  requestingReview: "flag",
  requestingApproval: "approve",
  creatingChannel: "channel",
  offeringConnectAi: "plug",
  findingTools: "search",
};

const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** A call's logo: the connector's mark from the catalog (by id or name), or the icon of one of our tools. */
function useLogo() {
  const catalog = useCatalog();
  return (a: { kind: ActivityKind; app?: string }) => {
    if (a.kind === "consulting" && a.app) {
      const key = plain(a.app);
      const def = catalog.data?.connectors.find((c) => plain(c.id) === key || plain(c.label) === key) ?? null;
      return <ConnectorIcon def={def} label={a.app} />;
    }
    return (
      <span className="tool-logo" aria-hidden="true">
        <Icon name={KIND_ICON[a.kind] ?? "plug"} size={14} />
      </span>
    );
  };
}

/** A line of the block from the shared model: its phrase, time, open view (code, output, what it got and gave). */
function blockLine(t: TFunction, locale: string, l: ToolLine, logo: ReactNode) {
  const lines = l.code ? l.code.source.split("\n").length : 0;
  const output = l.output ?? [];
  const label =
    l.code && l.state === "done"
      ? t("code.ranSummary", {
          count: lines,
          language: l.code.language,
          size: formatBytes(
            locale,
            output.reduce((n, o) => n + new TextEncoder().encode(o.text).length, 0),
          ),
        })
      : toolPhrase(t, l);
  const detail = l.code ? (
    <CodePanel code={l.code} output={output} live={l.state === "run"} />
  ) : output.length > 0 ? (
    <OutputView output={output} live={l.state === "run"} />
  ) : l.input || l.result || l.why ? (
    <div className="ac-tools__io">
      {l.input && (
        <>
          <b>{t("chat.work.gave")}</b>
          <span>{l.input}</span>
        </>
      )}
      {(l.result || l.why) && (
        <>
          <b>{l.state === "fail" ? t("chat.work.error") : t("chat.work.answered")}</b>
          <span>{l.result ?? l.why}</span>
        </>
      )}
    </div>
  ) : undefined;
  const line: ToolBlockLine = {
    key: l.key,
    state: l.state,
    logo,
    label,
    hint: l.code ? null : l.hint,
    time: l.ms !== null && l.state !== "run" ? formatLineTime(locale, l.ms) : undefined,
    count: l.count > 1 ? t("chat.work.times", { count: l.count }) : undefined,
    why: l.state === "fail" ? l.why : null,
    detail,
    defaultOpen: l.state === "run" && Boolean(l.code),
  };
  return line;
}

function useBlockItems(items: ToolItem[]): ToolBlockItem[] {
  const { t, i18n } = useTranslation();
  const logo = useLogo();
  return items.flatMap((item): ToolBlockItem[] =>
    item.kind === "call"
      ? [{ kind: "line", line: blockLine(t, i18n.language, item.line, logo(item.line)) }]
      : item.kind === "say"
        ? [{ kind: "note", key: item.key, node: item.text }]
        : [],
  );
}

/**
 * The tools of a reply while it works (and kept after, `done`): one line saying what it does now, the apps'
 * logos and the steps, opening into every call. What it said between calls is inside; the
 * messages it read stay outside, under the block, so "Leu seu recado" is always in sight.
 */
export function LiveTools({
  work,
  agentName,
  color,
  steerNote,
  done,
  stopped,
}: {
  work: LiveWork[];
  agentName: string;
  color?: AgentColor;
  steerNote?: (messageId: string) => SteerNote | undefined;
  /** The reply is done: "Usou 4 ferramentas". */
  done?: boolean;
  /** Stopped by someone: the call running then shows as stopped. */
  stopped?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const items = toolItemsLive(work, stopped);
  const blockItems = useBlockItems(items);
  const logo = useLogo();
  const calls = toolCalls(items);
  const steers = items.flatMap((i) => (i.kind === "steer" ? [i] : []));
  const now = toolNow(items);
  const said = items.flatMap((i) => (i.kind === "say" ? [i] : []));
  if (!now) {
    // Nothing called yet: what it said and read, as lines.
    return said.length + steers.length > 0 ? (
      <div className="live-work-notes">
        {items.map((i) =>
          i.kind === "say" ? (
            <p key={i.key} className="live-work__say">
              {i.text}
            </p>
          ) : i.kind === "steer" ? (
            <SteerWell key={i.key} now={i.now} note={steerNote?.(i.messageId)} />
          ) : null,
        )}
      </div>
    ) : null;
  }
  const total = items.reduce((n, i) => n + (i.kind === "call" ? (i.line.ms ?? 0) : 0), 0);
  const head = done
    ? {
        text: t("chat.work.used", { count: calls }),
        time: total > 0 ? formatDuration(t, total) : undefined,
      }
    : {
        text: blockLine(t, i18n.language, now, null).label,
        textKey: `${now.key}-${now.state}`,
        state: now.state,
        count: t("chat.work.steps", { count: calls }),
      };
  return (
    <>
      <ToolBlock
        logos={toolApps(items).map((a) => <span key={`${a.kind}-${a.app ?? ""}`}>{logo(a)}</span>)}
        head={head}
        items={blockItems}
        color={color}
        label={t("chat.work.block", agentGrammar(t, agentName))}
      />
      {steers.map((s) => (
        <SteerWell key={s.key} now={s.now} note={steerNote?.(s.messageId)} />
      ))}
    </>
  );
}

/**
 * The tools of a saved reply: closed, "Usou 4 ferramentas · 12 s" with the apps' logos from `meta.work`; its
 * steps load from `GET …/runs/{id}` only when opened (one request per opened message).
 */
export function SavedTools({
  runId,
  meta,
  agentName,
  color,
  skipScreens = [],
}: {
  runId: string;
  meta: Record<string, unknown> | undefined;
  agentName: string;
  color?: AgentColor;
  /** Screens whose calls have their own card on the message (`BrowserTrailCard`): left out here. */
  skipScreens?: ScreenKind[];
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const [open, setOpen] = useState(false);
  const run = useRun(org.id, open ? runId : null);
  const logo = useLogo();
  const compact = workMeta(meta);
  const onCard = (name: unknown) => skipScreens.some((screen) => isScreenTool(String(name ?? ""), screen));
  const work = run.data
    ? workFromSteps(
        run.data.steps.filter((s) => !(s.kind === "tool_call" && onCard(s.data.name))),
        run.data.run,
      )
    : null;
  const items = work ? toolItemsSaved(work) : [];
  const blockItems = useBlockItems(items);
  // Nothing to say: the server says it used no tools.
  if (compact && compact.steps === 0) return null;
  const calls = work ? toolCalls(items) : (compact?.steps ?? 0);
  const durationMs = work?.durationMs ?? compact?.durationMs ?? null;
  const apps = work
    ? toolApps(items)
    : (compact?.connectors ?? []).map((app) =>
        app === "Drive" ? { kind: "readingDrive" as const } : { kind: "consulting" as const, app },
      );
  const status: ToolBlockItem[] = run.isError
    ? [{ kind: "note", key: "error", node: t("chat.work.failed") }]
    : !work
      ? [
          {
            kind: "note",
            key: "loading",
            node: <PixelSpinner size={14} color={color} label={t("common.loading")} />,
          },
        ]
      : items.length === 0
        ? [{ kind: "note", key: "none", node: t("chat.work.none") }]
        : [];
  return (
    <ToolBlock
      logos={apps.map((a) => <span key={`${a.kind}-${a.app ?? ""}`}>{logo(a)}</span>)}
      head={{
        text: calls > 0 ? t("chat.work.used", { count: calls }) : t("chat.work.see", agentGrammar(t, agentName)),
        time: durationMs !== null ? formatDuration(t, durationMs) : undefined,
      }}
      items={[...status, ...blockItems]}
      color={color}
      label={t("chat.work.block", agentGrammar(t, agentName))}
      onToggle={setOpen}
    />
  );
}
