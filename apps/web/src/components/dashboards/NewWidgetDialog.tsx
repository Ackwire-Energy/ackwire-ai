import type { Agent, PinnableBlock, WidgetFormat, WidgetKind, WidgetSchedule, WidgetSize } from "@agenteschat/client";
import {
  useAgents,
  useCreateWidget,
  useDashboards,
  useHomeDashboard,
  usePinnableBlocks,
  usePinWidget,
  useWidgetCost,
  useWidgetSuggestions,
  widgetCostLine,
} from "@agenteschat/client";
import { canTalk } from "@agenteschat/client/lib/audience";
import { errorText } from "@agenteschat/client/lib/errors";
import { capitalize, formatUsd, joinNames, relativeTime } from "@agenteschat/client/lib/format";
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
import { type ReactNode, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { colorOf } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import "@/pages/dashboards.css";

/** The destination select's value for the person's own home board ("My Home"). */
const HOME = "home";
/** What "Pin from chat" offers for keeping a block updated: daily, hourly, or not at all. */
const PIN_SCHEDULES: readonly WidgetSchedule[] = ["day", "hour", "manual"];
/** The preview's title until the agent names the widget: what was asked, cut like a widget's title fits. */
const PREVIEW_TITLE_MAX = 44;

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
 * its condition — or pin a chart an agent already sent. Beside the form, the preview at its size (example data of
 * the kind until the agent builds it), the steps it will take and what it costs; under it, the board it goes on.
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

  const agent = agents.find((a) => a.id === agentId) ?? agents[0];
  const suggestions = useWidgetSuggestions(orgId, agent?.id, tab === "ask");
  const cost = useWidgetCost(orgId, agent?.id, schedule, tab === "ask");
  const boards = useDashboards(orgId);
  const home = useHomeDashboard(orgId, dest === HOME);
  const pinnable = usePinnableBlocks(orgId, tab === "pin");
  const create = useCreateWidget(orgId);
  const pin = usePinWidget(orgId);

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

  // The preview: the chosen block as it is, or example data of the kind asked (the agent's pick for "auto").
  const asked = text.trim();
  const previewAgent: Agent | undefined = tab === "pin" ? (chosen ? dir.anyAgent(chosen.agentId) : undefined) : agent;
  const previewKind: WidgetKind = format === "auto" ? (sug?.kind ?? sugs[0]?.kind ?? "kpi") : format;
  const preview: { title: string; spec: WidgetSpec } | null =
    tab === "pin"
      ? chosen && { title: chosen.title, spec: chosen.spec as WidgetSpec }
      : asked
        ? {
            title: sug ? sug.title : capitalize(asked, i18n.language).slice(0, PREVIEW_TITLE_MAX),
            spec: exampleWidgetSpec(previewKind, words),
          }
        : null;
  const name = previewAgent?.name ?? agent?.name ?? "";

  const ready =
    targetId !== null &&
    (tab === "pin" ? chosen !== null : Boolean(agent) && asked.length > 0) &&
    !create.isPending &&
    !pin.isPending;

  const done = () => {
    toast.show(t("dashboards.newWidget.created", { where }));
    onClose();
  };
  const failed = (error: unknown) => toast.show(errorText(t, error, i18n.language), "error");
  const submit = () => {
    if (!ready || targetId === null) return;
    if (tab === "pin" && chosen) {
      pin.mutate(
        { dashboardId: targetId, messageId: chosen.messageId, block: chosen.block, schedule, size },
        { onSuccess: done, onError: failed },
      );
      return;
    }
    if (!agent) return;
    create.mutate(
      {
        dashboardId: targetId,
        agentId: agent.id,
        prompt: asked,
        ...(sug && asked === (sug.prompt || sug.title) ? { title: sug.title } : {}),
        format,
        schedule,
        alert: { enabled: alertOn, condition: alertOn ? condition.trim() : "" },
        size,
      },
      { onSuccess: done, onError: failed },
    );
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
      <div className="db-f">
        <span className="db-lbl" id={`${id}-who`}>
          {t("dashboards.newWidget.who")}
        </span>
        {/* biome-ignore lint/a11y/useSemanticElements: toggle buttons under a field's label, not a fieldset */}
        <div className="db-agents" role="group" aria-labelledby={`${id}-who`}>
          {agents.length === 0 && <p className="db-hint">{t("dashboards.newWidget.noAgents")}</p>}
          {agents.map((a) => (
            <AgentChoice key={a.id} orgId={orgId} agent={a} on={a.id === agent?.id} onPick={() => pickAgent(a.id)} />
          ))}
        </div>
      </div>
      <div className="db-f">
        <span className="db-lbl" id={`${id}-format`}>
          {t("dashboards.newWidget.format")}
        </span>
        {/* biome-ignore lint/a11y/useSemanticElements: toggle buttons under a field's label, not a fieldset */}
        <div className="db-kinds" role="group" aria-labelledby={`${id}-format`}>
          {WIDGET_FORMATS.map((f) => (
            <button key={f} type="button" className="db-kind" aria-pressed={format === f} onClick={() => setFormat(f)}>
              <WidgetGlyph kind={f} size={28} />
              <span>{t(`widgets.kinds.${f}`)}</span>
            </button>
          ))}
        </div>
        {format === "auto" && agent && (
          <small className="db-hint">{t("dashboards.newWidget.autoHint", { name: agent.name })}</small>
        )}
      </div>
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

  // What happens once it's made, in order: who builds it and from what, its routine, its alert, its cost.
  const costLine = widgetCostLine(schedule, cost.data);
  const costText =
    costLine.kind === "day" || costLine.kind === "week"
      ? t(`widgets.cost.${costLine.kind}`, { amount: formatUsd(i18n.language, costLine.usd), name })
      : t(`widgets.cost.${costLine.kind}`, { name });
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
                title: t("dashboards.newWidget.steps.routine", { title: preview?.title ?? "…" }),
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
          { icon: "coin", title: costText },
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

  const previewPane: ReactNode = (
    <aside className="db-pv" aria-label={t("widgets.preview.label")}>
      <div className="db-pv__label">
        <span>{t("widgets.preview.label")}</span>
        <span className="db-pv__note">{preview && tab === "ask" ? t("widgets.preview.example") : ""}</span>
        <Segmented
          size="sm"
          label={t("widgets.sizes.label")}
          value={size}
          onValueChange={setSize}
          options={WIDGET_SIZES.map((s) => ({ value: s, label: t(`widgets.sizes.${s}`) }))}
        />
      </div>
      <div className="db-pv__stage" data-size={size}>
        {preview ? (
          <WidgetCard
            key={`${preview.spec.kind}:${size}`}
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
                  {t("widgets.foot", { name, when: t("common.now"), schedule: scheduleInline })}
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
        )}
      </div>
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
        <Button type="submit" variant="primary" disabled={!ready} loading={create.isPending || pin.isPending}>
          {tab === "pin" ? t("dashboards.newWidget.pin") : t("dashboards.newWidget.create")}
        </Button>
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

/**
 * One agent in "Who looks after it": its face, name, and its role with what it reads (the connections it may read,
 * known once its suggestions were asked for; only the chosen one asks).
 */
function AgentChoice({
  orgId,
  agent,
  on,
  onPick,
}: {
  orgId: string;
  agent: Agent;
  on: boolean;
  onPick: () => void;
}) {
  const { t } = useTranslation();
  // Read only for the chosen agent; the others show what an earlier pick already brought.
  const read = useWidgetSuggestions(orgId, agent.id, on);
  const sources = read.data?.sources ?? [];
  const line = sources.length
    ? agent.role
      ? t("dashboards.newWidget.reads", { role: agent.role, sources: joinNames(sources, t) })
      : t("dashboards.newWidget.steps.reads", { sources: joinNames(sources, t) })
    : agent.role;
  return (
    <button type="button" className="db-agent" aria-pressed={on} onClick={onPick}>
      <AgentAvatar agentId={agent.id} name={agent.name} size="sm" />
      <span>
        <b>{agent.name}</b>
        {line && <small>{line}</small>}
      </span>
    </button>
  );
}
