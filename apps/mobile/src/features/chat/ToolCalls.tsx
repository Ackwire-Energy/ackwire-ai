import { isScreenTool, type ScreenKind, useCatalog, useRun } from "@agenteschat/client";
import type { ActivityKind } from "@agenteschat/client/lib/activity";
import { formatBytes } from "@agenteschat/client/lib/files";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  formatDuration,
  formatLineTime,
  type ToolItem,
  type ToolLine,
  type ToolState,
  toolApps,
  toolCalls,
  toolItemsSaved,
  toolNow,
  toolPhrase,
  workFromSteps,
  workMeta,
} from "@agenteschat/client/lib/work";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import type { TFunction } from "i18next";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeInDown, ZoomIn } from "react-native-reanimated";
import { useFrameTime } from "@/agent/live";
import { stopBreath } from "@/agent/orbit";
import {
  CHROME_MAX_SCALE,
  Icon,
  type IconName,
  PixelDone,
  PixelFail,
  PixelOrbit,
  PixelStopped,
  Text,
  useReducedMotion,
} from "@/ui";
import { ConnectorIcon, IconTile } from "../connectors/ConnectorIcon";
import { useColors, useOrgId } from "../shared/hooks";
import { MONO, tapHaptic } from "../shared/parts";
import { CodeCard } from "./CodeCard";
import { MessageText } from "./MessageText";
import { outputTail } from "./turn";

/**
 * The tools of one reply, as on the web (`ToolCalls.tsx`, the UI kit's `ToolBlock`): one
 * flat card that stays one line while the agent works (the apps' logos, what it does now, the pixel mark)
 * and opens on a tap into every call, each opening again into what it ran or was given and answered. What
 * the agent said between calls sits inside, muted; the messages it read stay outside, under the block, so
 * "Leu seu recado" is always in sight. The words come from the shared model (`@agenteschat/client/lib/work`).
 */

/** Our own tools by what they do: their icon on the tile (a connector's call shows its mark). */
const KIND_ICON: Partial<Record<ActivityKind, IconName>> = {
  readingDrive: "drive",
  writingDrive: "drive",
  exportingFile: "drive",
  importingFile: "drive",
  uploadingArtifact: "drive",
  fetchingFile: "file",
  pcFiles: "file",
  creatingIssue: "issue",
  updatingIssue: "issue",
  readingIssues: "issue",
  startingTask: "issue",
  listingTasks: "issue",
  checkingTask: "issue",
  cancelingTask: "issue",
  searchingMemory: "brain",
  updatingMemory: "brain",
  gettingContext: "brain",
  checkingCalendar: "clock",
  schedulingEvent: "clock",
  schedulingReminder: "bell",
  cancelingReminder: "bell",
  listingReminders: "bell",
  creatingRoutine: "clock",
  updatingRoutine: "clock",
  listingRoutines: "clock",
  openingForumTopic: "chat",
  postingInForum: "chat",
  readingForum: "chat",
  writingWiki: "doc",
  readingWiki: "doc",
  linkingWiki: "doc",
  askingQuestion: "help",
  reacting: "smile",
  openingSkill: "sparkle",
  consultingSkill: "sparkle",
  runningSkillScript: "code",
  runningSkillScriptAny: "code",
  runningCode: "code",
  browsing: "globe",
  checkingComputer: "laptop",
  proposingMission: "flag",
  messagingMission: "flag",
  updatingPlan: "flag",
  reportingProgress: "flag",
  askingDecision: "flag",
  requestingReview: "flag",
  requestingApproval: "shield",
  creatingChannel: "hash",
  askingAgent: "agent",
  tellingAgent: "agent",
  findingTools: "search",
};

/** How many logos the closed line stacks (a phone has no room for more). */
const LOGOS_MAX = 4;

const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** A call's logo: the connector's mark from the catalog (by id or name), or the icon of one of our tools. */
function useLogo() {
  const catalog = useCatalog();
  return (a: { kind: ActivityKind; app?: string }, size = 20): ReactNode => {
    if (a.kind === "consulting" && a.app) {
      const key = plain(a.app);
      const def = catalog.data?.connectors.find((d) => plain(d.id) === key || plain(d.label) === key) ?? null;
      return <ConnectorIcon def={def} label={a.app} size={size} />;
    }
    return <IconTile name={KIND_ICON[a.kind] ?? "server"} size={size} />;
  };
}

// ── The block ────────────────────────────────────────────────────────────────

interface BlockLine {
  key: string;
  state: ToolState;
  logo: ReactNode;
  /** "Consultando o GitHub…", "Consultou o GitHub", "Rodou 12 linhas de python · saída 1 kB". */
  label: string;
  /** The tool's own name or the built-in's label: read aloud, not drawn (no room on a phone). */
  hint: string | null;
  /** "1,2 s". */
  time?: string;
  /** "×5": several calls of the same kind in a row. */
  count?: string;
  /** Why it failed, under the line. */
  why?: string | null;
  /** Its open view; without it the line doesn't open. */
  detail?: ReactNode;
  /** Opens by itself (a call running code shows it as it runs). */
  defaultOpen?: boolean;
}

type BlockItem = { kind: "line"; line: BlockLine } | { kind: "note"; key: string; node: ReactNode };

interface BlockHead {
  /** What it does now ("Consultando o banco…"), or "Usou 5 ferramentas" once done. */
  text: string;
  /** Changes when what it does changes: the words come up again. */
  textKey?: string;
  /** The mark after the words: the orbit while it works; none once done. */
  state?: ToolState;
  /** "4 passos" while it works: read aloud only (the phone's line has no room for it). */
  count?: string;
  /** "6 s" once done. */
  time?: string;
}

const POP = ZoomIn.springify().damping(11).stiffness(320).mass(0.6);

/**
 * The card: a hairline and the app's cut corner (bottom left small), one line that opens on a tap. `live`:
 * new logos pop in and the line's words come up when they change; a saved block draws still.
 */
function ToolBlock({
  logos,
  head,
  items,
  color,
  label,
  live = false,
  onToggle,
}: {
  logos: { key: string; node: ReactNode }[];
  head: BlockHead;
  items: BlockItem[];
  color: AgentColorName;
  /** The block's name for screen readers ("O que a Ana fez"). */
  label: string;
  live?: boolean;
  /** Opened (load the saved steps) or closed. */
  onToggle?: (open: boolean) => void;
}) {
  const c = useColors();
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const moving = live && !reduced;
  return (
    <View style={[styles.block, { backgroundColor: c.raised, borderColor: c.line2 }]}>
      <Pressable
        onPress={() => {
          tapHaptic();
          setOpen(!open);
          onToggle?.(!open);
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={[label, head.text, head.count, head.time].filter(Boolean).join(", ")}
        style={({ pressed }) => [styles.head, pressed && { backgroundColor: c.plateSoft }]}
      >
        {logos.length > 0 ? (
          <View style={styles.logos}>
            {logos.slice(0, LOGOS_MAX).map((l, i) => (
              <Animated.View
                key={l.key}
                entering={moving ? POP : undefined}
                style={[styles.stacked, i > 0 && styles.overlap, { borderColor: c.raised }]}
              >
                {l.node}
              </Animated.View>
            ))}
          </View>
        ) : null}
        {/* The new words come up inside the line, never over the divider under it. */}
        <View style={[styles.grow, styles.clip]}>
          <Animated.View key={head.textKey ?? head.text} entering={moving ? FadeInDown.duration(350) : undefined}>
            <Breathing on={head.state === "run"}>
              <Text variant="footnote" tone="ink2" numberOfLines={1} style={styles.medium}>
                {head.text}
              </Text>
            </Breathing>
          </Animated.View>
        </View>
        {head.time ? (
          <Text variant="caption" tone="faint" style={styles.num} maxFontSizeMultiplier={CHROME_MAX_SCALE}>
            {head.time}
          </Text>
        ) : null}
        {head.state ? <Mark state={head.state} color={color} /> : null}
        <View style={open ? styles.flip : undefined}>
          <Icon name="chev" size={13} color={c.faint} />
        </View>
      </Pressable>
      {open ? (
        <Animated.View
          entering={reduced ? undefined : FadeIn.duration(200)}
          style={[styles.lines, { borderTopColor: c.line }]}
        >
          {items.map((item) =>
            item.kind === "note" ? (
              <View key={item.key} style={styles.note}>
                {item.node}
              </View>
            ) : (
              <Line key={item.line.key} line={item.line} color={color} />
            ),
          )}
        </Animated.View>
      ) : null}
    </View>
  );
}

/** One call: logo, phrase, time, mark; a tap opens what it ran or was given and answered. */
function Line({ line, color }: { line: BlockLine; color: AgentColorName }) {
  const c = useColors();
  const [open, setOpen] = useState(line.defaultOpen === true);
  // Open while it runs (its code), it folds when the call ends; a tap opens it again.
  const running = useRef(line.state === "run");
  useEffect(() => {
    if (running.current && line.state !== "run") setOpen(false);
    running.current = line.state === "run";
  }, [line.state]);
  const opens = Boolean(line.detail);
  const said = [line.label, line.hint, line.count, line.time].filter(Boolean).join(", ");
  const row = (
    <>
      <View style={styles.logo}>{line.logo}</View>
      <View style={styles.grow}>
        <Breathing on={line.state === "run"}>
          <Text variant="footnote" tone="ink2" numberOfLines={1} style={styles.medium}>
            {line.label}
          </Text>
        </Breathing>
      </View>
      {line.count ? (
        <Text variant="caption" tone="faint" style={styles.num} maxFontSizeMultiplier={CHROME_MAX_SCALE}>
          {line.count}
        </Text>
      ) : null}
      {line.time ? (
        <Text variant="caption" tone="faint" style={styles.num} maxFontSizeMultiplier={CHROME_MAX_SCALE}>
          {line.time}
        </Text>
      ) : null}
      <Mark state={line.state} color={color} />
    </>
  );
  return (
    // A failed call says so by its mark and its reason, on the block's own surface (no tinted plate).
    <View style={styles.line}>
      {opens ? (
        <Pressable
          onPress={() => {
            tapHaptic();
            setOpen((o) => !o);
          }}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={said}
          style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.plateSoft }]}
        >
          {row}
        </Pressable>
      ) : (
        <View style={styles.row} accessible accessibilityLabel={said}>
          {row}
        </View>
      )}
      {line.why ? (
        <Text variant="caption" tone="danger" style={styles.why}>
          {line.why}
        </Text>
      ) : null}
      {open && opens ? <View style={styles.detail}>{line.detail}</View> : null}
    </View>
  );
}

/** The pixel marks: the orbit while it works, one green pixel when done, an exclamation if it failed. */
function Mark({ state, color }: { state: ToolState; color: AgentColorName }) {
  return (
    <View style={styles.mark}>
      {state === "run" ? (
        <PixelOrbit color={color} size={14} />
      ) : state === "done" ? (
        <PixelDone size={14} />
      ) : state === "fail" ? (
        <PixelFail size={14} />
      ) : (
        <PixelStopped size={12} />
      )}
    </View>
  );
}

/**
 * The words of the call running now breathe (1 → 0.6 → 1 every 1.6 s, the stop square's rhythm): the web
 * shimmers them, which a phone's text can't do without masking. Still with Reduce Motion.
 */
function Breathing({ on, children }: { on: boolean; children: ReactNode }) {
  const reduced = useReducedMotion();
  const t = useFrameTime(on && !reduced, 0);
  return <View style={on ? { opacity: stopBreath(t * 1000, reduced) } : undefined}>{children}</View>;
}

/** Monospace text on a sunken plate: what it printed, or what it was given and answered. */
function Plate({ rows }: { rows: { label?: string; text: string; danger?: boolean }[] }) {
  const c = useColors();
  return (
    <View style={[styles.plate, { backgroundColor: c.sunken, borderColor: c.line }]}>
      {rows.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the plate's rows, in order
        <View key={i} style={styles.plateRow}>
          {r.label ? (
            <Text variant="caption" tone="faint">
              {r.label}
            </Text>
          ) : null}
          <Text selectable style={[styles.mono, { color: r.danger ? c.danger : c.muted }]}>
            {r.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

const bytesOf = (output: readonly { text: string }[]) =>
  output.reduce((n, o) => n + new TextEncoder().encode(o.text).length, 0);

/** A line's open view: the code it ran (and what it printed), else what it was given and answered. */
function lineDetail(t: TFunction, l: ToolLine): ReactNode | undefined {
  const output = l.output ?? [];
  const printed = output.length > 0 ? outputTail(output) : "";
  if (l.code)
    return (
      <>
        <CodeCard lang={l.code.language} text={l.code.source} />
        {printed ? <Plate rows={[{ text: printed, danger: l.state === "fail" }]} /> : null}
      </>
    );
  if (printed) return <Plate rows={[{ text: printed, danger: l.state === "fail" }]} />;
  const answer = l.result ?? l.why;
  if (!l.input && !answer) return undefined;
  return (
    <Plate
      rows={[
        ...(l.input ? [{ label: t("chat.work.gave"), text: l.input }] : []),
        ...(answer
          ? [
              {
                label: l.state === "fail" ? t("chat.work.error") : t("chat.work.answered"),
                text: answer,
                danger: l.state === "fail",
              },
            ]
          : []),
      ]}
    />
  );
}

/** A code call's phrase once done ("Rodou 12 linhas de python · saída 1 kB"), else the shared phrase. */
function lineLabel(t: TFunction, locale: string, l: ToolLine) {
  if (!l.code || l.state !== "done") return toolPhrase(t, l);
  return t("code.ranSummary", {
    count: l.code.source.split("\n").length,
    language: l.code.language,
    size: formatBytes(locale, bytesOf(l.output ?? [])),
  });
}

/** A line of the block from the shared model. */
function blockLine(t: TFunction, locale: string, l: ToolLine, logo: ReactNode): BlockLine {
  return {
    key: l.key,
    state: l.state,
    logo,
    label: lineLabel(t, locale, l),
    hint: l.code ? null : l.hint,
    time: l.ms !== null && l.state !== "run" ? formatLineTime(locale, l.ms) : undefined,
    count: l.count > 1 ? t("chat.work.times", { count: l.count }) : undefined,
    why: l.state === "fail" ? l.why : null,
    detail: lineDetail(t, l),
    defaultOpen: l.state === "run" && Boolean(l.code),
  };
}

function useBlockItems(items: ToolItem[]): BlockItem[] {
  const { t, i18n } = useTranslation();
  const logo = useLogo();
  return items.flatMap((item): BlockItem[] =>
    item.kind === "call"
      ? [{ kind: "line", line: blockLine(t, i18n.language, item.line, logo(item.line)) }]
      : item.kind === "say"
        ? [
            {
              kind: "note",
              key: item.key,
              node: (
                <Text variant="footnote" tone="muted">
                  {item.text}
                </Text>
              ),
            },
          ]
        : [],
  );
}

const logoKey = (a: { kind: ActivityKind; app?: string }) => `${a.kind}-${a.app ?? ""}`;

// ── A reply's tools, live and kept ───────────────────────────────────────────

/**
 * The tools of an agent's turn while it works (and kept by its saved reply a moment after, `done`): the
 * block saying what it does now, opening into every call; the messages it read under it. Before its first
 * call, what it said and read are plain lines (as on the web's `LiveTools`).
 */
export function TurnTools({
  items,
  agentName,
  color,
  quoteOf,
  done = false,
  settled = false,
}: {
  items: ToolItem[];
  agentName: string;
  color: AgentColorName;
  /** A message's text (the "Leu seu recado" wells quote it). */
  quoteOf: (messageId: string) => string | undefined;
  /** The reply is done: "Usou 4 ferramentas · 6 s". */
  done?: boolean;
  /** Drawn by the saved reply (nothing comes in any more). */
  settled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const blockItems = useBlockItems(items);
  const logo = useLogo();
  const now = toolNow(items);
  if (!now) {
    // Done without a call: its words are the reply now; only the messages it read stay.
    const shown = done ? items.filter((i) => i.kind === "steer") : items;
    if (shown.length === 0) return null;
    return (
      <View style={styles.loose}>
        {shown.map((i) =>
          i.kind === "say" ? (
            <View key={i.key} style={styles.say}>
              <MessageText body={i.text} selectable={false} />
            </View>
          ) : i.kind === "steer" ? (
            <ReadWell key={i.key} now={i.now} quote={quoteOf(i.messageId) ?? ""} settled={settled} />
          ) : null,
        )}
      </View>
    );
  }
  const calls = toolCalls(items);
  const total = items.reduce((n, i) => n + (i.kind === "call" ? (i.line.ms ?? 0) : 0), 0);
  const head: BlockHead = done
    ? { text: t("chat.work.used", { count: calls }), time: total > 0 ? formatDuration(t, total) : undefined }
    : {
        text: lineLabel(t, i18n.language, now),
        textKey: `${now.key}-${now.state}`,
        state: now.state,
        count: t("chat.work.steps", { count: calls }),
      };
  return (
    <>
      <ToolBlock
        logos={toolApps(items).map((a) => ({ key: logoKey(a), node: logo(a, 18) }))}
        head={head}
        items={blockItems}
        color={color}
        label={t("chat.work.block", agentGrammar(t, agentName))}
        live={!done && !settled}
      />
      {items.map((i) =>
        i.kind === "steer" ? (
          <ReadWell key={i.key} now={i.now} quote={quoteOf(i.messageId) ?? ""} settled={settled} />
        ) : null,
      )}
    </>
  );
}

/**
 * The tools of a saved reply: closed, "Usou 4 ferramentas · 12 s" with the apps' logos from `meta.work`; its
 * steps load from `GET …/runs/{id}` only when opened (one request per opened message). Nothing when the
 * server says it used no tools.
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
  color: AgentColorName;
  /** Screens whose calls have their own card on the message (`TrailCard`): left out here. */
  skipScreens?: ScreenKind[];
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const [open, setOpen] = useState(false);
  const run = useRun(orgId, open ? runId : null);
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
  if (!compact || compact.steps === 0) return null;
  const calls = work ? toolCalls(items) : compact.steps;
  const durationMs = work?.durationMs ?? compact.durationMs;
  const apps = work
    ? toolApps(items)
    : compact.connectors.map((app) =>
        app === "Drive" ? { kind: "readingDrive" as const } : { kind: "consulting" as const, app },
      );
  const note = (key: string, node: ReactNode): BlockItem => ({ kind: "note", key, node });
  const status: BlockItem[] = run.isError
    ? [
        note(
          "error",
          <Text variant="footnote" tone="muted">
            {t("chat.work.failed")}
          </Text>,
        ),
      ]
    : !work
      ? [
          note(
            "loading",
            <View style={styles.loading}>
              <PixelOrbit color={color} size={14} />
              <Text variant="footnote" tone="faint">
                {t("mobile.common.loading")}
              </Text>
            </View>,
          ),
        ]
      : items.length === 0
        ? [
            note(
              "none",
              <Text variant="footnote" tone="muted">
                {t("chat.work.none")}
              </Text>,
            ),
          ]
        : [];
  return (
    <ToolBlock
      logos={apps.map((a) => ({ key: logoKey(a), node: logo(a, 18) }))}
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

/**
 * A message it read while working, under its tools: "Leu seu recado · …", or "Parou para ler seu recado ·
 * …" when it was asked to stop and read (until then the message itself says "lê na próxima pausa").
 */
function ReadWell({ now, quote, settled }: { now: boolean; quote: string; settled: boolean }) {
  const { t } = useTranslation();
  const c = useColors();
  const reduced = useReducedMotion();
  return (
    <Animated.View
      entering={reduced || settled ? undefined : FadeIn.duration(260)}
      style={[styles.well, { backgroundColor: c.sunken }]}
    >
      <Icon name={now ? "bolt" : "eye"} size={13} color={c.muted} />
      <Text variant="small" tone="ink2" style={styles.wellTitle} numberOfLines={1}>
        {t(now ? "mobile.chat.steer.wellNow" : "mobile.chat.steer.well")}
      </Text>
      {quote ? (
        <Text variant="small" tone="muted" numberOfLines={1} style={styles.shrink}>
          {quote}
        </Text>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // Flat: a hairline and the cut corner (the app's "tato com canto"), no shadow.
  block: {
    marginTop: 6,
    marginBottom: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderBottomRightRadius: 16,
    borderBottomLeftRadius: 4,
    overflow: "hidden",
  },
  head: { flexDirection: "row", alignItems: "center", gap: 9, minHeight: 42, paddingLeft: 12, paddingRight: 10 },
  logos: { flexDirection: "row", alignItems: "center", flexShrink: 0 },
  stacked: { borderRadius: 7, borderWidth: 1.5 },
  overlap: { marginLeft: -7 },
  grow: { flex: 1, minWidth: 0 },
  clip: { overflow: "hidden" },
  shrink: { flexShrink: 1 },
  medium: { fontWeight: "500" },
  num: { fontVariant: ["tabular-nums"] },
  mark: { width: 16, height: 16, alignItems: "center", justifyContent: "center" },
  flip: { transform: [{ rotate: "180deg" }] },
  lines: { borderTopWidth: StyleSheet.hairlineWidth, padding: 4 },
  line: { borderRadius: 10 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    minHeight: 40,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 10,
  },
  logo: { width: 20, alignItems: "center" },
  why: { marginTop: -4, paddingLeft: 37, paddingRight: 8, paddingBottom: 8 },
  detail: { marginHorizontal: 8, marginBottom: 8, gap: 8 },
  plate: {
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  plateRow: { gap: 2 },
  mono: { fontFamily: MONO, fontSize: 12, lineHeight: 18 },
  // What it said between calls: under the phrases, muted.
  note: { marginTop: 2, marginBottom: 4, marginLeft: 37, marginRight: 8 },
  loading: { flexDirection: "row", alignItems: "center", gap: 8 },
  loose: { marginTop: 2, marginBottom: 4, gap: 2 },
  say: { marginVertical: 2 },
  // "Leu seu recado": a sunken well with the "tato com canto" corner.
  well: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    alignSelf: "flex-start",
    maxWidth: "100%",
    marginVertical: 6,
    paddingVertical: 6,
    paddingLeft: 8,
    paddingRight: 10,
    borderTopLeftRadius: 11,
    borderTopRightRadius: 11,
    borderBottomRightRadius: 11,
    borderBottomLeftRadius: 3,
  },
  wellTitle: { fontWeight: "600", flexShrink: 0 },
});
