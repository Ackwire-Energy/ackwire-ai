import type {
  Agent,
  PinnableBlock,
  Widget,
  WidgetFormat,
  WidgetKind,
  WidgetSchedule,
  WidgetSize,
} from "@agenteschat/client";
import {
  useAgents,
  useConfirmWidget,
  useDashboards,
  useHomeDashboard,
  usePinnableBlocks,
  usePinWidget,
  useRemoveWidget,
  useTestWidget,
  useWidgetCost,
  useWidgetDraft,
  useWidgetSuggestions,
  widgetCostLine,
} from "@agenteschat/client";
import { canTalk } from "@agenteschat/client/lib/audience";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatUsd, joinNames, relativeTime } from "@agenteschat/client/lib/format";
import {
  Button,
  Dialog,
  DialogFooter,
  Icon,
  type IconName,
  Input,
  Segmented,
  Select,
  Switch,
  TabPanel,
  Tabs,
  Textarea,
  useDarkTheme,
  useNow,
  WidgetCard,
  WidgetGlyph,
  widgetTileVars,
} from "@agenteschat/ui";
import {
  type ExampleWords,
  exampleWidgetSpec,
  sizeToLayout,
  WIDGET_FORMATS,
  WIDGET_SCHEDULES,
  WIDGET_SIZES,
  type WidgetSpec,
} from "@agenteschat/ui/widgets/spec";
import type { TFunction } from "i18next";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { colorOf } from "@/components/Sky";
import { failureText, neutralWidgetTitle } from "@/components/widgets/parts";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import "@/pages/dashboards.css";

/** The destination select's value for the person's own home board ("My Home"). */
const HOME = "home";
/** What "Pin from chat" offers for keeping a block updated: daily, hourly, or not at all. */
const PIN_SCHEDULES: readonly WidgetSchedule[] = ["day", "hour", "manual"];
/** A widget's title, as long as the server takes it (ADR 0134). */
const TITLE_MAX = 80;

/** The words of a preview's example data in the reader's language (`widgets.example.*`). */
export function exampleWordsOf(t: TFunction): ExampleWords {
  return {
    days: (["d1", "d2", "d3", "d4", "d5", "d6", "d7"] as const).map((d) => t(`widgets.example.days.${d}`)),
    vsYesterday: t("widgets.example.vsYesterday"),
    goalLine: t("widgets.example.goalLine"),
    goalNote: t("widgets.example.goalNote"),
    lineNote: t("widgets.example.lineNote"),
    rows: [t("widgets.example.row1"), t("widgets.example.row2"), t("widgets.example.row3")],
    rowMeta: [t("widgets.example.meta1"), t("widgets.example.meta2"), t("widgets.example.meta3")],
    items: [t("widgets.example.item1"), t("widgets.example.item2")],
  };
}

export interface NewWidgetDialogProps {
  orgId: string;
  open: boolean;
  onClose: () => void;
  /** The board it goes on by default; null = My Home. */
  dashboardId: string | null;
  /** Which way it opens: asking an agent, or pinning a chart from the chat. */
  tab?: "ask" | "pin";
}

/**
 * New widget (ADR 0134 §3): ask an agent the person can talk to for a number, chart or list it keeps up to date —
 * what to follow (with the agent's suggestions), who looks after it, the format, how often it updates, an alert and
 * its condition — or pin a chart an agent already sent. Beside the form, the preview at its size, the steps it will
 * take and what it costs; under it, the board it goes on. Asking is tested first: Test has the agent build a draft
 * with real data, shown live in the preview, and only a draft that worked for what is asked now can be created.
 * Used by a board's page and by Home.
 */
export function NewWidgetDialog({ orgId, open, onClose, dashboardId, tab = "ask" }: NewWidgetDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("dashboards.newWidget.title")}
      description={t("dashboards.newWidget.subtitle")}
      closeLabel={t("common.close")}
      width={980}
      className="db-dialog db-nw"
    >
      {open && <NewWidgetBody orgId={orgId} dashboardId={dashboardId} initialTab={tab} onClose={onClose} />}
    </Dialog>
  );
}

type Tab = "ask" | "pin";

/**
 * Where the test of what is asked stands: none yet, the draft being built (or the test being sent), built (`ok`),
 * failed, or made for an ask that changed since (`stale`: its prompt, agent or format).
 */
type TestPhase = "none" | "testing" | "ok" | "failed" | "stale";

function phaseOf(sending: boolean, draft: Widget | undefined, draftId: string | null, stale: boolean): TestPhase {
  if (sending) return "testing";
  if (!draftId) return "none";
  if (stale) return "stale";
  if (!draft || draft.status === "building" || draft.status === "updating") return "testing";
  return draft.status === "ok" ? "ok" : "failed";
}

function NewWidgetBody({
  orgId,
  dashboardId,
  initialTab,
  onClose,
}: {
  orgId: string;
  dashboardId: string | null;
  initialTab: Tab;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const dark = useDarkTheme();
  const now = useNow(30_000);
  const id = useId();
  const agents = (useAgents(orgId).data ?? []).filter((a) => !a.former && canTalk(a));
  const [tab, setTab] = useState<Tab>(initialTab);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<number | null>(null);
  const [format, setFormat] = useState<WidgetFormat>("auto");
  const [schedule, setSchedule] = useState<WidgetSchedule>(initialTab === "pin" ? "day" : "hour");
  const [alertOn, setAlertOn] = useState(true);
  const [condition, setCondition] = useState("");
  const [size, setSize] = useState<WidgetSize>("m");
  const [dest, setDest] = useState<string>(dashboardId ?? HOME);
  const [block, setBlock] = useState<number | null>(null);
  // The test: the draft it made, the ask it was made for, and the title as the person edits it (null = the agent's).
  const [draftId, setDraftId] = useState<string | null>(null);
  const [testedFor, setTestedFor] = useState<string | null>(null);
  const [titleEdit, setTitleEdit] = useState<string | null>(null);

  const agent = agents.find((a) => a.id === agentId) ?? agents[0];
  const suggestions = useWidgetSuggestions(orgId, agent?.id, tab === "ask");
  const cost = useWidgetCost(orgId, agent?.id, schedule, tab === "ask");
  const boards = useDashboards(orgId);
  const home = useHomeDashboard(orgId, dest === HOME);
  const pinnable = usePinnableBlocks(orgId, tab === "pin");
  const test = useTestWidget(orgId);
  const confirm = useConfirmWidget(orgId);
  const remove = useRemoveWidget(orgId);
  const pin = usePinWidget(orgId);
  const live = useWidgetDraft(orgId, draftId).data ?? (test.data?.id === draftId ? test.data : undefined);
  const draft = draftId && live?.id === draftId ? live : undefined;

  // A draft nobody created is deleted when the dialog closes or another test replaces it (the server sweeps any
  // left behind after a day). `pending` is the draft still to delete; one being created is kept.
  const pending = useRef<string | null>(null);
  const confirming = useRef(false);
  const alive = useRef(true);
  const drop = useRef(remove.mutate);
  drop.current = remove.mutate;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (pending.current && !confirming.current) drop.current(pending.current);
      pending.current = null;
    };
  }, []);

  const sources = suggestions.data?.sources ?? [];
  const sugs = suggestions.data?.suggestions ?? [];
  const sug = picked === null ? null : (sugs[picked] ?? null);
  const blocks = pinnable.data ?? [];
  const chosen = block === null ? null : (blocks[block] ?? null);
  const editable = (boards.data?.dashboards ?? []).filter((d) => d.kind === "board" && d.canEdit);
  const destOptions = [
    { value: HOME, label: t("dashboards.home") },
    ...editable.map((d) => ({ value: d.id, label: d.title })),
  ];
  const where = destOptions.find((o) => o.value === dest)?.label ?? t("dashboards.home");
  const targetId = dest === HOME ? (home.data?.id ?? null) : dest;
  const words = exampleWordsOf(t);

  const asked = text.trim();
  // What a test answers for: what is asked, of whom, in what format (schedule, alert, size and board don't count).
  const askKey = JSON.stringify([asked, agent?.id ?? "", format]);
  const phase: TestPhase =
    tab === "ask" ? phaseOf(test.isPending, draft, draftId, draftId !== null && testedFor !== askKey) : "none";
  const tested = phase === "ok" && draft !== undefined ? draft : null;
  const title = tested ? (titleEdit ?? tested.title) : "";
  const testedWhen = tested?.refreshedAt
    ? relativeTime(t, i18n.language, tested.refreshedAt, new Date(now))
    : t("common.now");

  // The preview: the chosen block as it is; the draft as the agent built it; or example data of the kind asked (the
  // agent's pick for "auto"), named by its format until the agent names it.
  const previewAgent: Agent | undefined = tab === "pin" ? (chosen ? dir.anyAgent(chosen.agentId) : undefined) : agent;
  const previewKind: WidgetKind = format === "auto" ? (sug?.kind ?? sugs[0]?.kind ?? "kpi") : format;
  const unnamed = neutralWidgetTitle(t, format === "auto" ? null : format);
  const preview: { title: string; spec: WidgetSpec } | null =
    tab === "pin"
      ? chosen && { title: chosen.title, spec: chosen.spec as WidgetSpec }
      : tested?.spec
        ? { title: title.trim() || neutralWidgetTitle(t, tested.kind), spec: tested.spec }
        : asked && phase !== "testing" && phase !== "failed"
          ? { title: sug ? sug.title : unnamed, spec: exampleWidgetSpec(previewKind, words) }
          : null;
  const name = previewAgent?.name ?? agent?.name ?? "";
  const agentName = agent?.name ?? t("dashboards.newWidget.theAgent");

  const failed = (error: unknown) => toast.show(errorText(t, error, i18n.language), "error");
  const canTest = tab === "ask" && Boolean(agent) && asked.length > 0 && targetId !== null && phase !== "testing";
  const busy = confirm.isPending || pin.isPending;
  const alertInput = { enabled: alertOn, condition: alertOn ? condition.trim() : "" };

  /** Test: the agent builds a draft now, with real data; the draft before it goes. */
  const runTest = () => {
    if (!canTest || !agent || targetId === null) return;
    const before = pending.current;
    pending.current = null;
    if (before) remove.mutate(before);
    setDraftId(null);
    setTitleEdit(null);
    const forAsk = askKey;
    const made = (draftMade: Widget) => {
      // Closed while it was sent: nobody will create it.
      if (!alive.current) {
        drop.current(draftMade.id);
        return;
      }
      pending.current = draftMade.id;
      setDraftId(draftMade.id);
      setTestedFor(forAsk);
    };
    const refused = (error: unknown) => {
      if (alive.current) failed(error);
    };
    const input = {
      dashboardId: targetId,
      agentId: agent.id,
      prompt: asked,
      ...(sug && asked === (sug.prompt || sug.title) ? { title: sug.title } : {}),
      format,
      schedule,
      alert: alertInput,
      size,
    };
    // Its promise, not the mutation's callbacks: those don't run once the dialog is gone, and the draft must go then.
    void test.mutateAsync(input).then(made, refused);
  };

  /** Create widget: the tested draft goes on the board, with the title, size, schedule and alert chosen now. */
  const create = () => {
    if (!tested || targetId === null || busy) return;
    confirming.current = true;
    confirm.mutate(
      {
        widgetId: tested.id,
        dashboardId: targetId,
        // Only a title the person wrote: theirs is kept from then on; otherwise the agent's from the test stays.
        ...(titleEdit?.trim() && titleEdit.trim() !== tested.title ? { title: titleEdit.trim() } : {}),
        size,
        schedule,
        alert: alertInput,
      },
      {
        onSuccess: () => {
          pending.current = null;
          toast.show(t("dashboards.newWidget.created", { where }));
          onClose();
        },
        onError: (error) => {
          confirming.current = false;
          failed(error);
        },
      },
    );
  };

  const submit = () => {
    if (tab === "pin") {
      if (!chosen || targetId === null || busy) return;
      pin.mutate(
        { dashboardId: targetId, messageId: chosen.messageId, block: chosen.block, schedule, size },
        {
          onSuccess: () => {
            toast.show(t("dashboards.newWidget.created", { where }));
            onClose();
          },
          onError: failed,
        },
      );
      return;
    }
    if (tested) create();
    else runTest();
  };

  const pickTab = (next: Tab) => {
    setTab(next);
    if (next === "pin" && !PIN_SCHEDULES.includes(schedule)) setSchedule("day");
  };
  const pickSuggestion = (index: number) => {
    const s = sugs[index];
    if (!s) return;
    setPicked(index);
    setText(s.prompt || s.title);
    if (s.alert) setCondition(s.alert);
  };
  const pickAgent = (next: string) => {
    setAgentId(next);
    setPicked(null);
  };

  const tones = (who: { appearance?: unknown } | undefined) => widgetTileVars(colorOf(who), dark);
  const scheduleInline = t(`widgets.schedulesInline.${schedule}`);

  // "Who looks after it": face, name and role (what it reads shows in the steps, beside the preview).
  const agentOptions = agents.map((a) => ({
    value: a.id,
    label: a.name,
    description: a.role || undefined,
    leading: <AgentAvatar agentId={a.id} name={a.name} size="xs" />,
  }));
  const formatOptions = WIDGET_FORMATS.map((f) => ({
    value: f,
    label: t(`widgets.kinds.${f}`),
    description: t(`dashboards.newWidget.formatHints.${f}`, { name: agentName }),
    leading: <WidgetGlyph kind={f} size={20} />,
  }));

  const askForm = (
    <>
      <div className="db-f">
        <label className="db-lbl" htmlFor={`${id}-what`}>
          {t("dashboards.newWidget.what")}
        </label>
        <Textarea
          id={`${id}-what`}
          rows={2}
          value={text}
          maxLength={2000}
          placeholder={t("dashboards.newWidget.whatPlaceholder")}
          onChange={(e) => {
            setText(e.target.value);
            if (sug && e.target.value !== (sug.prompt || sug.title)) setPicked(null);
          }}
        />
        {sugs.length > 0 && (
          // biome-ignore lint/a11y/useSemanticElements: toggle buttons under a field's label, not a fieldset
          <div className="db-sugs" role="group" aria-label={t("dashboards.newWidget.suggestions")}>
            {sugs.map((s, i) => (
              <button
                key={s.title}
                type="button"
                className="db-sug"
                aria-pressed={picked === i}
                style={tones(agent)}
                onClick={() => pickSuggestion(i)}
              >
                <span className="db-sug__glyph">
                  <WidgetGlyph kind={s.kind} size={18} />
                </span>
                {s.title}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="db-pair">
        <div className="db-f">
          <span className="db-lbl" aria-hidden="true">
            {t("dashboards.newWidget.who")}
          </span>
          {agents.length === 0 ? (
            <p className="db-hint">{t("dashboards.newWidget.noAgents")}</p>
          ) : (
            <Select
              aria-label={t("dashboards.newWidget.who")}
              value={agent?.id}
              onValueChange={pickAgent}
              options={agentOptions}
              renderValue={(o) => (
                <span className="db-dd">
                  <AgentAvatar agentId={o.value} name={o.label} size="xs" />
                  {o.label}
                </span>
              )}
            />
          )}
        </div>
        <div className="db-f">
          <span className="db-lbl" aria-hidden="true">
            {t("dashboards.newWidget.format")}
          </span>
          <Select<WidgetFormat>
            aria-label={t("dashboards.newWidget.format")}
            value={format}
            onValueChange={setFormat}
            options={formatOptions}
            renderValue={(o) => (
              <span className="db-dd">
                <WidgetGlyph kind={o.value} size={20} />
                {o.label}
              </span>
            )}
          />
        </div>
      </div>
      {tested && (
        <div className="db-f">
          <label className="db-lbl" htmlFor={`${id}-title`}>
            {t("dashboards.newWidget.titleField")}
          </label>
          <Input
            id={`${id}-title`}
            value={title}
            maxLength={TITLE_MAX}
            placeholder={neutralWidgetTitle(t, tested.kind)}
            onChange={(e) => setTitleEdit(e.target.value)}
          />
        </div>
      )}
      <div className="db-f">
        <span className="db-lbl">{t("dashboards.newWidget.updates")}</span>
        <Segmented
          label={t("dashboards.newWidget.updates")}
          value={schedule}
          onValueChange={setSchedule}
          options={WIDGET_SCHEDULES.map((s) => ({ value: s, label: t(`widgets.schedulesShort.${s}`) }))}
        />
      </div>
      <div className="db-f db-alert">
        <div className="db-alert__row">
          <Switch
            id={`${id}-alert`}
            checked={alertOn}
            onCheckedChange={setAlertOn}
            aria-describedby={`${id}-alert-hint`}
          />
          <span>
            <label htmlFor={`${id}-alert`}>
              <b>{t("widgets.alert.label")}</b>
            </label>
            <small id={`${id}-alert-hint`}>{t("widgets.alert.hint")}</small>
          </span>
        </div>
        {alertOn && (
          <label className="db-cond" htmlFor={`${id}-cond`}>
            <span>{t("widgets.alert.condition")}</span>
            <Input
              id={`${id}-cond`}
              value={condition}
              maxLength={200}
              placeholder={t("widgets.alert.placeholder")}
              onChange={(e) => setCondition(e.target.value)}
            />
          </label>
        )}
      </div>
    </>
  );

  const pinForm = (
    <>
      <div className="db-f">
        <span className="db-lbl" id={`${id}-blocks`}>
          {t("dashboards.newWidget.fromChat")}
        </span>
        {pinnable.isSuccess && blocks.length === 0 ? (
          <p className="db-hint">{t("dashboards.newWidget.noBlocks")}</p>
        ) : (
          <div className="db-picks" role="radiogroup" aria-labelledby={`${id}-blocks`}>
            {blocks.map((b, i) => (
              // biome-ignore lint/a11y/useSemanticElements: a block's row (its glyph, title and place) in a radio group
              <button
                key={`${b.messageId}:${b.block}`}
                type="button"
                role="radio"
                className="db-pick"
                aria-checked={block === i}
                style={tones(dir.anyAgent(b.agentId))}
                onClick={() => setBlock(i)}
              >
                <span className="db-pick__glyph">
                  <WidgetGlyph kind={b.spec.kind} size={28} />
                </span>
                <span className="db-pick__text">
                  <b>{b.title}</b>
                  <small>{placeOf(t, i18n.language, b, dir.anyAgent(b.agentId)?.name ?? "")}</small>
                </span>
                <span className="db-radio" aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
        <small className="db-hint">
          <Icon name="pin" size={14} />
          {t("dashboards.newWidget.pinHint")}
        </small>
      </div>
      <div className="db-f">
        <span className="db-lbl">{t("dashboards.newWidget.keepUpdated")}</span>
        <Segmented
          label={t("dashboards.newWidget.keepUpdated")}
          value={schedule}
          onValueChange={setSchedule}
          options={PIN_SCHEDULES.map((s) => ({
            value: s,
            label: s === "manual" ? t("dashboards.newWidget.onlyPin") : t(`widgets.schedulesShort.${s}`),
          }))}
        />
      </div>
    </>
  );

  // What happens once it's made, in order: who builds it and from what, its routine, its alert, its cost (and what
  // the test cost, once there was one).
  const costLine = widgetCostLine(schedule, cost.data);
  const costText =
    costLine.kind === "day" || costLine.kind === "week"
      ? t(`widgets.cost.${costLine.kind}`, { amount: formatUsd(i18n.language, costLine.usd), name })
      : t(`widgets.cost.${costLine.kind}`, { name });
  const lastCost = phase === "ok" || phase === "failed" ? (draft?.lastCostUsd ?? null) : null;
  const testCost =
    lastCost === null ? undefined : t("dashboards.newWidget.testCost", { cost: formatUsd(i18n.language, lastCost) });
  const steps: { icon: IconName; title: string; hint?: string }[] =
    tab === "ask"
      ? [
          {
            icon: "bolt",
            title: t("dashboards.newWidget.steps.builds", { name }),
            hint: sources.length
              ? t("dashboards.newWidget.steps.reads", { sources: joinNames(sources, t) })
              : undefined,
          },
          schedule === "manual"
            ? { icon: "routines", title: t("dashboards.newWidget.steps.noRoutine") }
            : {
                icon: "routines",
                title: t("dashboards.newWidget.steps.routine", { title: preview?.title ?? unnamed }),
                hint: t("dashboards.newWidget.steps.routineHint", { schedule: t(`widgets.schedules.${schedule}`) }),
              },
          alertOn
            ? {
                icon: "bell",
                title: t("dashboards.newWidget.steps.alert", {
                  condition: condition.trim() || t("widgets.alert.placeholder"),
                }),
                hint: t("dashboards.newWidget.steps.alertHint"),
              }
            : {
                icon: "bell",
                title: t("dashboards.newWidget.steps.noAlert"),
                hint: t("dashboards.newWidget.steps.noAlertHint"),
              },
          { icon: "coin", title: costText, hint: testCost },
        ]
      : [
          {
            icon: "pin",
            title: t("dashboards.newWidget.steps.pinAsIs"),
            hint: chosen ? placeOf(t, i18n.language, chosen, name) : undefined,
          },
          schedule === "manual"
            ? {
                icon: "routines",
                title: t("dashboards.newWidget.steps.noRedo"),
                hint: t("dashboards.newWidget.steps.noRedoHint"),
              }
            : {
                icon: "routines",
                title: t("dashboards.newWidget.steps.redoes", {
                  name: name || t("dashboards.newWidget.theAgent"),
                  schedule: scheduleInline,
                }),
                hint: t("dashboards.newWidget.steps.redoesHint"),
              },
        ];

  // Over the preview: example data, real data and when it came, or that the ask changed since the test.
  const note =
    tab !== "ask"
      ? ""
      : tested
        ? t("dashboards.newWidget.tested", { when: testedWhen })
        : phase === "stale"
          ? t("dashboards.newWidget.stale")
          : preview && phase === "none"
            ? t("widgets.preview.example")
            : "";

  const stage: ReactNode =
    tab === "ask" && (phase === "testing" || phase === "failed") ? (
      // The draft being built with real data, or why it didn't work, with Try again.
      <WidgetCard
        key={`test:${phase}:${size}`}
        className="db-pv__card"
        data-size={size}
        title={unnamed}
        spec={null}
        status={phase === "testing" ? "building" : "failed"}
        color={colorOf(agent)}
        size={sizeToLayout(size)}
        locale={i18n.language}
        buildingText={phase === "testing" ? t("dashboards.newWidget.testing", { name }) : undefined}
        footer={
          phase === "failed" ? (
            <span className="wg__warn" role="status">
              <Icon name="alert" size={14} />
              <span>
                {t("dashboards.newWidget.testFailed", { reason: failureText(t, draft?.failure ?? null, name) })}{" "}
                <button type="button" className="wg__resolve" disabled={!canTest} onClick={runTest}>
                  {t("dashboards.newWidget.tryAgain")}
                </button>
              </span>
            </span>
          ) : null
        }
      />
    ) : preview ? (
      <WidgetCard
        key={`${tested ? "real" : "example"}:${preview.spec.kind}:${size}`}
        className="db-pv__card"
        data-size={size}
        title={preview.title}
        spec={preview.spec}
        status="ok"
        color={colorOf(previewAgent)}
        size={sizeToLayout(size)}
        locale={i18n.language}
        footer={
          <>
            {previewAgent && <AgentAvatar agentId={previewAgent.id} name={previewAgent.name} size="xs" />}
            <span className="db-pv__when">
              {t("widgets.foot", { name, when: tested ? testedWhen : t("common.now"), schedule: scheduleInline })}
            </span>
          </>
        }
      />
    ) : (
      <WidgetCard
        className="db-pv__card db-pv__card--empty"
        data-size={size}
        title=""
        spec={null}
        status="building"
        color={colorOf(previewAgent ?? agent)}
        size={sizeToLayout(size)}
        locale={i18n.language}
        buildingText={
          tab === "pin"
            ? t("dashboards.newWidget.pickBlock")
            : t("dashboards.newWidget.emptyPreview", { name: agent?.name ?? "" })
        }
        footer={null}
      />
    );

  const previewPane: ReactNode = (
    <aside className="db-pv" aria-label={t("widgets.preview.label")}>
      <div className="db-pv__label">
        <span>{t("widgets.preview.label")}</span>
        <span className="db-pv__note" data-tone={phase === "stale" ? "warn" : undefined}>
          {note}
        </span>
        <Segmented
          size="sm"
          label={t("widgets.sizes.label")}
          value={size}
          onValueChange={setSize}
          options={WIDGET_SIZES.map((s) => ({ value: s, label: t(`widgets.sizes.${s}`) }))}
        />
      </div>
      <div className="db-pv__stage" data-size={size}>
        {stage}
      </div>
      {tab === "ask" && asked && (phase === "none" || phase === "stale") && (
        <p className="db-hint db-pv__first">
          <Icon name="info" size={14} />
          {t("dashboards.newWidget.testFirst")}
        </p>
      )}
      <ul className="db-steps">
        {steps.map((s) => (
          <li key={`${s.icon}:${s.title}`}>
            <Icon name={s.icon} size={16} />
            <span>
              <b>{s.title}</b>
              {s.hint && <small>{s.hint}</small>}
            </span>
          </li>
        ))}
      </ul>
    </aside>
  );

  const grid = (form: ReactNode) => (
    <div className="db-nw__grid">
      <div className="db-nw__form">{form}</div>
      {previewPane}
    </div>
  );

  return (
    <form
      className="db-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="db-nw__tabs">
        <Tabs
          value={tab}
          onValueChange={pickTab}
          label={t("dashboards.newWidget.title")}
          items={[
            { value: "ask", label: t("dashboards.newWidget.tabAsk") },
            { value: "pin", label: t("dashboards.newWidget.tabPin") },
          ]}
        >
          <TabPanel value="ask">{grid(askForm)}</TabPanel>
          <TabPanel value="pin">{grid(pinForm)}</TabPanel>
        </Tabs>
      </div>
      <DialogFooter className="db-nw__foot">
        <span className="db-dest">
          <Icon name="grid" size={16} />
          <label htmlFor={`${id}-dest`}>{t("dashboards.newWidget.destination")}</label>
          <Select id={`${id}-dest`} size="sm" value={dest} onValueChange={setDest} options={destOptions} />
        </span>
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        {tab === "pin" ? (
          <Button
            type="submit"
            variant="primary"
            disabled={!chosen || targetId === null || busy}
            loading={pin.isPending}
          >
            {t("dashboards.newWidget.pin")}
          </Button>
        ) : tested ? (
          <>
            <Button icon="refresh" disabled={!canTest || busy} onClick={runTest}>
              {t("dashboards.newWidget.testAgain")}
            </Button>
            <Button type="submit" variant="primary" disabled={busy || targetId === null} loading={confirm.isPending}>
              {t("dashboards.newWidget.create")}
            </Button>
          </>
        ) : (
          <Button type="submit" variant="primary" icon="bolt" disabled={!canTest} loading={phase === "testing"}>
            {t("dashboards.newWidget.test")}
          </Button>
        )}
      </DialogFooter>
    </form>
  );
}

/** "Nina in #support · yesterday": where an agent sent the chart, and when. */
function placeOf(t: TFunction, locale: string, b: PinnableBlock, agentName: string): string {
  const when = relativeTime(t, locale, b.at);
  if (b.place.kind === "dm") return t("dashboards.newWidget.place.dm", { name: agentName, when });
  if (!b.place.name) return t("dashboards.newWidget.place.unnamed", { name: agentName, when });
  return t(b.place.kind === "thread" ? "dashboards.newWidget.place.thread" : "dashboards.newWidget.place.channel", {
    name: agentName,
    channel: b.place.name,
    when,
  });
}
