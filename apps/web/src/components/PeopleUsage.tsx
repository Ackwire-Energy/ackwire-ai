import type {
  AppNotification,
  Message,
  PeopleUsage,
  PersonLimitCard,
  PersonLimits,
  PersonUsage,
  UsagePlace,
} from "@agenteschat/client";
import {
  keys,
  useApi,
  usePeopleUsage,
  usePersonLimits,
  usePersonUsage,
  useRaisePersonLimit,
  useRefuseMoreUsage,
  useRoles,
  useSetPersonLimits,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import {
  capitalize,
  formatDecimal,
  formatInt,
  formatMonth,
  formatShortDate,
  formatUsd,
  relativeTime,
} from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import {
  chipCounts,
  filterPeople,
  PEOPLE_CHIPS,
  type PeopleChip,
  type PeopleSort,
  type PersonRow,
  sortPeople,
  USAGE_PERIODS,
  type UsagePeriodKind,
  usagePeriod,
} from "@agenteschat/client/lib/person-usage";
import { parseAmount } from "@agenteschat/client/lib/text";
import {
  AvatarStack,
  agentGradient,
  Button,
  Card,
  Checkbox,
  Dialog,
  DialogBody,
  Icon,
  InfoHint,
  Input,
  Meter,
  Radio,
  RadioGroup,
  RoleMark,
  Segmented,
  Select,
  TabPanel,
  Tabs,
  UsageDays,
  UsageSwatch,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar, AgentAvatar } from "@/components/AgentAvatar";
import { fileSaver } from "@/components/artifacts/fileSaver";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { colorOf } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import "./people-usage.css";

/*
 * Usage per person (ADR 0141): Configurações › Orçamento e uso › Pessoas (admins: each person's month, their
 * drawer, the limits, the CSV, who uses agents now) and Seu uso (everyone: their own month in percentages), and the
 * card an agent posts when the person behind its run is at their limit. A DM's work is a count and its cost, never
 * a title.
 */

type Dir = ReturnType<typeof useDirectory>;

const partStyle = (dir: Dir, agentId: string) =>
  ({ "--part": agentGradient(colorOf(dir.agentById.get(agentId)))[0] }) as CSSProperties;

const agentName = (t: TFunction, dir: Dir, id: string) => dir.anyAgent(id)?.name ?? t("channel.unknownAgent");

/** The tabs of Orçamento e uso: Resumo (what was there) and Pessoas for who sees money, else Seu uso. */
export function UsageTabs({ summary, person }: { summary: ReactNode; person?: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const money = can(org, "view_usage");
  const [tab, setTab] = useState<"summary" | "people">(person ? "people" : "summary");
  useEffect(() => {
    if (person) setTab("people");
  }, [person]);
  return (
    <Tabs
      value={tab}
      onValueChange={setTab}
      label={t("settings.section.usage")}
      items={[
        { value: "summary", label: t("peopleUsage.tabs.summary") },
        { value: "people", label: money ? t("peopleUsage.tabs.people") : t("peopleUsage.tabs.mine") },
      ]}
    >
      <TabPanel value="summary">{summary}</TabPanel>
      <TabPanel value="people">{money ? <PeopleTab person={person} /> : <MyUsage />}</TabPanel>
    </Tabs>
  );
}

function PeopleTab({ person }: { person?: string }) {
  const { t } = useTranslation();
  const [view, setView] = useState<"usage" | "limits">("usage");
  const segmented = (
    <Segmented
      value={view}
      onValueChange={setView}
      label={t("peopleUsage.tabs.people")}
      size="sm"
      options={[
        { value: "usage", label: t("peopleUsage.view.usage") },
        { value: "limits", label: t("peopleUsage.view.limits") },
      ]}
    />
  );
  return view === "usage" ? (
    <PeopleView switcher={segmented} person={person} onLimits={() => setView("limits")} />
  ) : (
    <LimitsView switcher={segmented} />
  );
}

/** "Agora" in a row: with which agent, where (as the viewer may see it), or when they last used one. */
function nowLine(t: TFunction, locale: string, dir: Dir, p: PersonRow) {
  if (!p.now) {
    return p.lastActiveAt
      ? t("peopleUsage.now.last", { when: relativeTime(t, locale, p.lastActiveAt) })
      : t("peopleUsage.now.never");
  }
  return placeLine(t, p.now.place, agentName(t, dir, p.now.agentId));
}

function placeLine(t: TFunction, place: UsagePlace, agent: string) {
  if (place.kind === "channel") return t("peopleUsage.now.channel", { agent, channel: place.channelName ?? "" });
  if (place.kind === "routine") return t("peopleUsage.now.routine", { name: place.routineName ?? "" });
  if (place.kind === "hidden") return t("peopleUsage.now.hidden", { agent });
  return t("peopleUsage.now.private", { agent });
}

/** A month's use against a limit: the amount, of the limit, the bar amber from 80% and red at it. */
function UseMeter({ p, plansOnly }: { p: PersonRow; plansOnly: boolean }) {
  const { t, i18n } = useTranslation();
  const amount = formatUsd(i18n.language, p.monthUsd);
  const shown = plansOnly ? t("peopleUsage.meter.estimate", { amount }) : amount;
  return (
    <div className="pu-meter" data-state={p.state}>
      <span className="pu-meter__line">
        <b className="tabular">{shown}</b>
        <span className="muted">
          {p.limitUsd === null
            ? t("peopleUsage.meter.noLimit")
            : t("peopleUsage.meter.of", { limit: formatDecimal(i18n.language, p.limitUsd) })}
        </span>
        {p.state === "at" && <span className="pu-meter__at">{t("peopleUsage.chips.at")}</span>}
      </span>
      {p.limitUsd !== null && (
        <Meter value={Math.min(p.monthUsd, p.limitUsd)} max={p.limitUsd} label={shown} marks={[80]} />
      )}
    </div>
  );
}

function PeopleView({ switcher, person, onLimits }: { switcher: ReactNode; person?: string; onLimits: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const dir = useDirectory(org.id);
  const roles = useRoles(org.id);
  const [period, setPeriod] = useState<UsagePeriodKind>("month");
  const [roleId, setRoleId] = useState("all");
  const [agentId, setAgentId] = useState("all");
  const [chips, setChips] = useState<PeopleChip[]>([]);
  const [sort, setSort] = useState<{ by: PeopleSort; desc: boolean }>({ by: "usage", desc: true });
  const [open, setOpen] = useState<string | null>(person ?? null);
  useEffect(() => {
    if (person) setOpen(person);
  }, [person]);
  const range = usagePeriod(period);
  const usage = usePeopleUsage(org.id, range);
  if (usage.isLoading) return <LoadingList count={6} avatar trailing />;
  if (!usage.data) return <ErrorState error={usage.error} onRetry={() => void usage.refetch()} />;
  const data = usage.data;
  const counts = chipCounts(data.people);
  const roleList = (roles.data?.roles ?? []).filter((r) => r.kind === "custom");
  const roleById = new Map(roleList.map((r) => [r.id, r]));
  const rows = sortPeople(
    filterPeople(data.people, {
      roleId: roleId === "all" ? null : roleId,
      agentId: agentId === "all" ? null : agentId,
      chips,
    }),
    sort.by,
    sort.desc,
    i18n.language,
  );
  const month = capitalize(formatMonth(i18n.language, new Date(`${data.month}-15T12:00:00`)), i18n.language);
  const head = (by: PeopleSort, label: string, className?: string) => (
    <th className={className} aria-sort={sort.by === by ? (sort.desc ? "descending" : "ascending") : undefined}>
      <button
        type="button"
        className="pu-sort"
        onClick={() => setSort((s) => ({ by, desc: s.by === by ? !s.desc : by !== "name" }))}
      >
        {label}
        {sort.by === by && <Icon name={sort.desc ? "chevronDown" : "chevronUp"} size={14} />}
      </button>
    </th>
  );
  const nobody = data.people.every((p) => p.runs === 0);
  return (
    <>
      <div className="pu-head">
        <div className="pu-head__text">
          <h3 className="pu-title">
            {t("peopleUsage.title")}
            <InfoHint name={t("common.about", { label: t("peopleUsage.title") })}>
              {data.plansOnly
                ? t("common.joinSentences", { a: t("peopleUsage.about"), b: t("peopleUsage.plansAbout") })
                : t("peopleUsage.about")}
            </InfoHint>
          </h3>
          <span className="muted">
            {t("peopleUsage.sub", {
              month,
              count: data.people.length,
              amount: data.plansOnly
                ? t("peopleUsage.meter.estimate", { amount: formatUsd(i18n.language, data.totalUsd) })
                : formatUsd(i18n.language, data.totalUsd),
            })}
          </span>
        </div>
        <span className="pu-head__acts">
          <Button
            size="sm"
            icon="download"
            onClick={() =>
              fileSaver.save(
                api.orgs.peopleUsageCsvUrl(org.id, range),
                `usage-per-person-${new Date().toISOString().slice(0, 10)}.csv`,
              )
            }
          >
            {t("peopleUsage.export")}
          </Button>
          {switcher}
        </span>
      </div>
      <div className="pu-toolbar">
        <Select
          size="sm"
          aria-label={t("peopleUsage.periodLabel")}
          value={period}
          onValueChange={setPeriod}
          options={USAGE_PERIODS.map((p) => ({ value: p, label: t(`peopleUsage.period.${p}`) }))}
        />
        <Select
          size="sm"
          aria-label={t("peopleUsage.role")}
          value={roleId}
          onValueChange={setRoleId}
          options={[
            { value: "all", label: t("peopleUsage.roleAll") },
            ...roleList.map((r) => ({
              value: r.id,
              label: r.name,
              leading: <RoleMark color={r.color} icon={r.icon} size={16} />,
            })),
          ]}
        />
        <Select
          size="sm"
          aria-label={t("peopleUsage.agent")}
          value={agentId}
          onValueChange={setAgentId}
          options={[
            { value: "all", label: t("peopleUsage.agentAll") },
            ...dir.agents.map((a) => ({ value: a.id, label: a.name })),
          ]}
        />
        {PEOPLE_CHIPS.map((c) => {
          const on = chips.includes(c);
          return (
            <button
              key={c}
              type="button"
              className="pu-chip"
              aria-pressed={on}
              onClick={() => setChips((l) => (on ? l.filter((x) => x !== c) : [...l, c]))}
            >
              {t(`peopleUsage.chips.${c}`)}
              <span className="pu-chip__n tabular">{counts[c]}</span>
            </button>
          );
        })}
      </div>
      <p className="pu-summary">
        <span data-tone="near">{t("peopleUsage.summary.near", { n: counts.near })}</span>
        {" · "}
        <span data-tone="at">{t("peopleUsage.summary.at", { n: counts.at })}</span>
        {" · "}
        <span>{t("peopleUsage.summary.idle", { n: counts.idle })}</span>
      </p>
      {!data.limitsOn && (
        <p className="pu-hint">
          <Icon name="info" size={16} />
          <button type="button" className="ac-link" onClick={onLimits}>
            {t("peopleUsage.limitsHint")}
          </button>
        </p>
      )}
      <LiveCard live={data.live} />
      {nobody && period === "month" ? (
        <p className="plan-empty">{t("peopleUsage.empty")}</p>
      ) : (
        <Card className="pu-table-card">
          <table className="pu-table">
            <thead>
              <tr>
                {head("name", t("peopleUsage.columns.person"))}
                <th>{t("peopleUsage.columns.now")}</th>
                {head("runs", t("peopleUsage.columns.runs"), "pu-num")}
                <th>{t("peopleUsage.columns.agents")}</th>
                {head("usage", t("peopleUsage.columns.usage"))}
                <th>{t("peopleUsage.columns.caresFor")}</th>
                {head("created", t("peopleUsage.columns.created"), "pu-num")}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const role = p.roleIds.map((id) => roleById.get(id)).find(Boolean);
                return (
                  <tr key={p.userId} className="pu-row" onClick={() => setOpen(p.userId)}>
                    <td>
                      <button type="button" className="pu-person" onClick={() => setOpen(p.userId)}>
                        <ActorAvatar actor={{ type: "person", id: p.userId }} name={p.name} size="sm" presence />
                        <span className="pu-person__text">
                          <span className="pu-person__name">{p.name}</span>
                          <span className="pu-person__role">
                            {role ? (
                              <>
                                <RoleMark color={role.color} icon={role.icon} size={14} />
                                {role.name}
                              </>
                            ) : p.owner ? (
                              t("peopleUsage.owner")
                            ) : (
                              t("peopleUsage.member")
                            )}
                          </span>
                        </span>
                      </button>
                    </td>
                    <td className={p.now ? "pu-now pu-now--live" : "pu-now"}>
                      <span className={p.now?.place.kind === "private" ? "ac-iconline" : undefined}>
                        {p.now?.place.kind === "private" && <Icon name="lock" size={14} />}
                        <span>{nowLine(t, i18n.language, dir, p)}</span>
                      </span>
                    </td>
                    <td className="pu-num tabular">{formatInt(i18n.language, p.runs)}</td>
                    <td>
                      <Faces
                        ids={p.agents.map((a) => a.agentId)}
                        titles={p.agents.map((a) => `${agentName(t, dir, a.agentId)} ${a.share}%`)}
                      />
                    </td>
                    <td className="pu-use">
                      <UseMeter p={p} plansOnly={data.plansOnly} />
                    </td>
                    <td>
                      <Faces ids={p.caresFor} />
                    </td>
                    <td className="pu-num tabular">{p.created || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      <PersonDrawer userId={open} onClose={() => setOpen(null)} />
    </>
  );
}

function Faces({ ids, titles }: { ids: string[]; titles?: string[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  if (ids.length === 0) return <span className="muted">—</span>;
  return (
    <AvatarStack className="pu-faces">
      {ids.slice(0, 3).map((id, i) => (
        <span key={id} title={titles?.[i] ?? agentName(t, dir, id)}>
          <AgentAvatar agentId={id} name={agentName(t, dir, id)} size="xs" labelled />
        </span>
      ))}
    </AvatarStack>
  );
}

/** "Agora": who is using which agent right now. */
function LiveCard({ live }: { live: PeopleUsage["live"] }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  if (live.length === 0) return null;
  const people = new Set(live.map((w) => w.personId).filter(Boolean)).size;
  return (
    <Card className="pu-live" aria-labelledby="pu-live-title">
      <h4 id="pu-live-title" className="pu-live__title">
        <span className="pu-live__dot" aria-hidden="true" />
        {t("peopleUsage.live.title")}
        <span className="pu-chip__n tabular">{people}</span>
      </h4>
      <ul className="pu-live__list">
        {live.slice(0, 8).map((w) => {
          const who = w.personId ? (dir.memberById.get(w.personId)?.name ?? t("channel.unknownPerson")) : null;
          const agent = agentName(t, dir, w.agentId);
          return (
            <li key={`${w.agentId}-${w.startedAt}`} className="pu-live__row">
              <AgentAvatar agentId={w.agentId} name={agent} size="xs" />
              <span className="pu-live__text">
                <b>{w.routine ? t("peopleUsage.live.routineOf", { name: who ?? "" }) : (who ?? agent)}</b>
                {" → "}
                {agent}
                <span className="muted">
                  {" · "}
                  {[placeLine(t, w.place, agent), w.title, relativeTime(t, i18n.language, w.startedAt)]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** The month day by day, stacked by agent in their colors, with its legend. */
function DaysChart({ data, money }: { data: PersonUsage; money: boolean }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const since = new Date(data.since);
  const until = new Date(data.until);
  const month = data.days[0]?.date.slice(0, 7) ?? data.since.slice(0, 7);
  const sameMonth = since.getUTCMonth() === new Date(`${month}-15`).getUTCMonth();
  const daysInMonth = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const total = (d: { agents: Record<string, number> }) => Object.values(d.agents).reduce((a, b) => a + b, 0);
  const max = Math.max(1e-9, ...data.days.map(total));
  const today = until.getUTCDate();
  const columns = Array.from({ length: sameMonth ? daysInMonth : data.days.length }, (_, i) => {
    const date = sameMonth ? `${month}-${String(i + 1).padStart(2, "0")}` : (data.days[i]?.date ?? "");
    const day = data.days.find((d) => d.date === date);
    if (sameMonth && i + 1 > today) return { key: date, parts: [], ahead: true };
    return {
      key: date,
      parts: Object.entries(day?.agents ?? {}).map(([id, v]) => ({
        key: id,
        value: (v / max) * 100,
        style: partStyle(dir, id),
      })),
    };
  });
  const amount = (v: number) => (money ? formatUsd(i18n.language, v) : `${Math.round(v)}%`);
  return (
    <div className="pu-days">
      <UsageDays days={columns} label={t("peopleUsage.drawer.days")} />
      {sameMonth && (
        <div className="pu-axis tabular" aria-hidden="true">
          <span>{formatShortDate(i18n.language, `${month}-01T12:00:00`)}</span>
          <span>15</span>
          <span>{daysInMonth}</span>
        </div>
      )}
      <div className="plan-legend">
        {data.agents.map((a) => (
          <span key={a.agentId} className="plan-legend__item">
            <UsageSwatch style={partStyle(dir, a.agentId)} />
            {agentName(t, dir, a.agentId)} · {amount(a.amount)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** What they did, newest first: a channel's work with its title; a DM or a private channel as a count. */
function RecentList({ data }: { data: PersonUsage }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const amount = (v: number) =>
    data.money ? formatUsd(i18n.language, v) : t("peopleUsage.mine.ofLimit", { percent: Math.round(v) });
  if (data.recent.length === 0) return <p className="plan-empty">{t("peopleUsage.drawer.noUse")}</p>;
  return (
    <ul className="pu-recent">
      {data.recent.map((r) => {
        const agent = agentName(t, dir, r.agentId);
        const [title, line] =
          r.kind === "work"
            ? r.place.kind === "routine"
              ? [
                  t("peopleUsage.drawer.routine", { name: r.place.routineName ?? "" }),
                  [agent, relativeTime(t, i18n.language, r.startedAt)].join(" · "),
                ]
              : [
                  r.title || t("peopleUsage.drawer.untitled"),
                  [
                    t("peopleUsage.drawer.with", { agent }),
                    r.place.kind === "channel" ? `#${r.place.channelName}` : null,
                    t("peopleUsage.drawer.minutes", { n: r.minutes }),
                  ]
                    .filter(Boolean)
                    .join(" · "),
                ]
            : [
                r.kind === "private"
                  ? t("peopleUsage.drawer.private", { agent })
                  : t("peopleUsage.drawer.hidden", { agent }),
                t("peopleUsage.drawer.runs", { count: r.runs }),
              ];
        return (
          <li key={`${r.kind}-${r.agentId}-${"startedAt" in r ? r.startedAt : r.lastAt}`} className="pu-recent__row">
            <AgentAvatar agentId={r.agentId} name={agent} size="sm" />
            <span className="pu-recent__text">
              <span className="pu-recent__title">
                {r.kind !== "work" && <Icon name="lock" size={14} />}
                {title}
              </span>
              <span className="muted">{line}</span>
            </span>
            <span className="pu-recent__amount tabular">{amount(r.amount)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function limitFromText(t: TFunction, l: PersonUsage["limit"], roleName: (id: string) => string) {
  switch (l.limitFrom) {
    case "raised":
      return t("peopleUsage.from.raised");
    case "person":
      return t("peopleUsage.from.person");
    case "role":
      return t("peopleUsage.from.role", { role: roleName(l.limitRoleId ?? "") });
    case "default":
      return t("peopleUsage.from.default");
    default:
      return "";
  }
}

/** A person's month, at the side (480 px): their limit, use per day, agents, what they did and created. */
function PersonDrawer({ userId, onClose }: { userId: string | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const roles = useRoles(org.id);
  const usage = usePersonUsage(org.id, userId);
  const raise = useRaisePersonLimit(org.id);
  const toast = useToast();
  const [raising, setRaising] = useState<string | null>(null);
  const data = usage.data;
  const roleName = (id: string) => roles.data?.roles.find((r) => r.id === id)?.name ?? "";
  const member = userId ? dir.memberById.get(userId) : undefined;
  const role = data?.roleIds.map((id) => roles.data?.roles.find((r) => r.id === id)).find(Boolean);
  const l = data?.limit;
  const submitRaise = () => {
    const v = parseAmount(raising ?? "");
    if (!userId || !(v > 0)) return;
    raise.mutate([userId, v], {
      onSuccess: () => {
        setRaising(null);
        toast.show(t("peopleUsage.drawer.raised"));
      },
      onError: (e) => toast.show(errorText(t, e), "error"),
    });
  };
  return (
    <Dialog
      open={userId !== null}
      onOpenChange={(o) => !o && onClose()}
      title={data?.name ?? member?.name ?? ""}
      closeLabel={t("common.close")}
      className="pu-drawer"
      width={480}
      leading={
        userId ? (
          <ActorAvatar actor={{ type: "person", id: userId }} name={member?.name ?? ""} size="md" presence />
        ) : null
      }
      subtitle={
        role ? (
          <span className="pu-person__role">
            <RoleMark color={role.color} icon={role.icon} size={14} />
            {role.name}
          </span>
        ) : data?.owner ? (
          t("peopleUsage.owner")
        ) : (
          t("peopleUsage.member")
        )
      }
    >
      {!data ? (
        <DialogBody>
          {usage.isError ? (
            <ErrorState error={usage.error} onRetry={() => void usage.refetch()} />
          ) : (
            <LoadingList count={5} avatar trailing />
          )}
        </DialogBody>
      ) : (
        <div className="pu-drawer__body">
          {l && l.limitUsd != null ? (
            <section className="pu-limit" data-state={l.state}>
              <div className="pu-limit__head">
                <b>{t("peopleUsage.drawer.limit", { amount: formatUsd(i18n.language, l.limitUsd) })}</b>
                <span className="muted">{limitFromText(t, l, roleName)}</span>
              </div>
              <Meter
                value={Math.min(l.monthUsd ?? 0, l.limitUsd)}
                max={l.limitUsd}
                label={t("peopleUsage.drawer.limit", { amount: formatUsd(i18n.language, l.limitUsd) })}
                marks={[80]}
              />
              <span className="pu-limit__line">
                {l.reachedAt
                  ? t("peopleUsage.drawer.reached", {
                      date: formatShortDate(i18n.language, l.reachedAt),
                      used: formatUsd(i18n.language, l.monthUsd ?? 0),
                    })
                  : t("peopleUsage.drawer.used", {
                      used: formatUsd(i18n.language, l.monthUsd ?? 0),
                      percent: Math.round(l.percent ?? 0),
                    })}
              </span>
              {raising === null ? (
                <span className="pu-limit__acts">
                  <Button size="sm" variant="primary" onClick={() => setRaising(String(l.raiseToUsd ?? l.limitUsd))}>
                    {l.requested && l.raiseToUsd
                      ? t("peopleUsage.actions.raise", { amount: formatUsd(i18n.language, l.raiseToUsd) })
                      : t("peopleUsage.drawer.raise")}
                  </Button>
                  {l.requested && <span className="pu-limit__asked">{t("peopleUsage.drawer.asked")}</span>}
                </span>
              ) : (
                <form
                  className="pu-limit__acts"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitRaise();
                  }}
                >
                  <Input
                    aria-label={t("peopleUsage.drawer.raiseTo")}
                    inputMode="decimal"
                    value={raising}
                    onChange={(e) => setRaising(e.target.value)}
                    className="pu-amount"
                    autoFocus
                  />
                  <Button size="sm" variant="primary" type="submit" loading={raise.isPending}>
                    {t("peopleUsage.drawer.raiseSave")}
                  </Button>
                  <Button size="sm" onClick={() => setRaising(null)}>
                    {t("common.cancel")}
                  </Button>
                </form>
              )}
            </section>
          ) : (
            <p className="muted">{t("peopleUsage.drawer.noLimit")}</p>
          )}
          <section>
            <h4 className="pu-h4">{t("peopleUsage.drawer.days")}</h4>
            <DaysChart data={data} money={data.money} />
          </section>
          {data.agents.length > 0 && (
            <section>
              <h4 className="pu-h4">{t("peopleUsage.drawer.agents")}</h4>
              <ul className="pu-agents">
                {data.agents.map((a) => (
                  <li key={a.agentId}>
                    <AgentAvatar agentId={a.agentId} name={agentName(t, dir, a.agentId)} size="sm" />
                    <b>{agentName(t, dir, a.agentId)}</b>
                    <span className="muted">{t("peopleUsage.drawer.runs", { count: a.runs })}</span>
                    <span className="pu-recent__amount tabular">{formatUsd(i18n.language, a.amount)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h4 className="pu-h4">{t("peopleUsage.drawer.recent")}</h4>
            <RecentList data={data} />
          </section>
          {data.created.length > 0 && (
            <section>
              <h4 className="pu-h4">{t("peopleUsage.drawer.created")}</h4>
              <ul className="pu-agents">
                {data.created.map((c) => (
                  <li key={c.agentId}>
                    <AgentAvatar agentId={c.agentId} name={agentName(t, dir, c.agentId)} size="sm" />
                    <b>{agentName(t, dir, c.agentId)}</b>
                    <span className="muted">
                      {t("peopleUsage.drawer.createdAt", { date: formatShortDate(i18n.language, c.createdAt) })}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <Link
            to="/org/$orgId/settings/$section"
            params={{ orgId: org.id, section: "audit" }}
            className="pu-audit ac-link"
          >
            <Icon name="shield" size={16} />
            {t("peopleUsage.drawer.audit")}
          </Link>
        </div>
      )}
    </Dialog>
  );
}

type Choice = "default" | "none" | "amount";
const choiceOf = (v: number | null | undefined, has: boolean): Choice =>
  !has ? "default" : v === null || v === undefined ? "none" : "amount";

/** One limit: "Usar o padrão" (not for the default itself), "Sem limite" or an amount a month. */
function LimitPick({
  id,
  label,
  value,
  has,
  allowDefault,
  onChange,
}: {
  id: string;
  label: string;
  value: number | null | undefined;
  has: boolean;
  allowDefault: boolean;
  onChange: (next: { has: boolean; value: number | null }) => void;
}) {
  const { t, i18n } = useTranslation();
  const choice = choiceOf(value, has);
  const [text, setText] = useState(value ? new Intl.NumberFormat(i18n.language).format(value) : "");
  return (
    <span className="pu-pick">
      <Select<Choice>
        size="sm"
        id={id}
        aria-label={label}
        value={choice}
        onValueChange={(c) =>
          onChange(
            c === "default"
              ? { has: false, value: null }
              : c === "none"
                ? { has: true, value: null }
                : { has: true, value: parseAmount(text) || 20 },
          )
        }
        options={[
          ...(allowDefault ? [{ value: "default" as const, label: t("peopleUsage.limits.useDefault") }] : []),
          { value: "none", label: t("peopleUsage.limits.none") },
          { value: "amount", label: t("peopleUsage.limits.amount") },
        ]}
      />
      {choice === "amount" && (
        <span className="pu-usd">
          <span aria-hidden="true">US$</span>
          <Input
            aria-label={label}
            inputMode="decimal"
            value={text || (value ? String(value) : "")}
            onChange={(e) => {
              setText(e.target.value);
              const n = parseAmount(e.target.value);
              if (n > 0) onChange({ has: true, value: n });
            }}
            className="pu-amount"
          />
        </span>
      )}
    </span>
  );
}

/** Limites: the default, per role, per person, what happens at the limit and the 80% notice. */
function LimitsView({ switcher }: { switcher: ReactNode }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const roles = useRoles(org.id);
  const limits = usePersonLimits(org.id);
  const save = useSetPersonLimits(org.id);
  const toast = useToast();
  const editable = can(org, "configure");
  const [draft, setDraft] = useState<PersonLimits | null>(null);
  useEffect(() => {
    if (limits.data && !draft) setDraft(limits.data);
  }, [limits.data, draft]);
  if (!draft) {
    return limits.isError ? (
      <ErrorState error={limits.error} onRetry={() => void limits.refetch()} />
    ) : (
      <LoadingList count={4} avatar={false} trailing />
    );
  }
  const roleList = (roles.data?.roles ?? []).filter((r) => r.kind === "custom");
  const people = dir.members.filter((m) => m.userId in draft.people);
  const others = dir.members.filter((m) => !(m.userId in draft.people) && m.role !== "owner");
  const set = (patch: Partial<PersonLimits>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setIn = (field: "roles" | "people", id: string, next: { has: boolean; value: number | null }) => {
    const copy = { ...draft[field] };
    if (next.has) copy[id] = next.value;
    else delete copy[id];
    set({ [field]: copy });
  };
  return (
    <>
      <div className="pu-head">
        <h3 className="pu-title">{t("peopleUsage.limits.title")}</h3>
        {switcher}
      </div>
      <Card className="pu-limits">
        <p className="pu-lead">{t("peopleUsage.limits.lead")}</p>
        <div className="pu-limits__row">
          <span className="pu-limits__label">
            <b>{t("peopleUsage.limits.default")}</b>
            <span className="muted">{t("peopleUsage.limits.defaultHint")}</span>
          </span>
          <LimitPick
            id="pu-default"
            label={t("peopleUsage.limits.default")}
            value={draft.defaultUsd}
            has={draft.defaultUsd !== null}
            allowDefault={false}
            onChange={(n) => set({ defaultUsd: n.value })}
          />
        </div>
        <div className="pu-limits__row pu-limits__row--list">
          <b className="pu-limits__label">{t("peopleUsage.limits.byRole")}</b>
          <ul className="pu-limits__list">
            {roleList.map((r) => (
              <li key={r.id}>
                <span className="pu-limits__who">
                  <RoleMark color={r.color} icon={r.icon} size={18} />
                  {r.name}
                </span>
                <LimitPick
                  id={`pu-role-${r.id}`}
                  label={r.name}
                  value={draft.roles[r.id]}
                  has={r.id in draft.roles}
                  allowDefault
                  onChange={(n) => setIn("roles", r.id, n)}
                />
              </li>
            ))}
          </ul>
        </div>
        <div className="pu-limits__row pu-limits__row--list">
          <b className="pu-limits__label">{t("peopleUsage.limits.people")}</b>
          <ul className="pu-limits__list">
            {people.map((m) => (
              <li key={m.userId}>
                <span className="pu-limits__who">
                  <ActorAvatar actor={{ type: "person", id: m.userId }} name={m.name} size="xs" />
                  {m.name}
                </span>
                <LimitPick
                  id={`pu-person-${m.userId}`}
                  label={m.name}
                  value={draft.people[m.userId]}
                  has
                  allowDefault
                  onChange={(n) => setIn("people", m.userId, n)}
                />
              </li>
            ))}
            {others.length > 0 && (
              <li>
                <Select
                  size="sm"
                  aria-label={t("peopleUsage.limits.addPerson")}
                  placeholder={t("peopleUsage.limits.addPerson")}
                  value={undefined}
                  onValueChange={(id) => setIn("people", id, { has: true, value: draft.defaultUsd ?? 20 })}
                  options={others.map((m) => ({
                    value: m.userId,
                    label: m.name,
                    leading: <ActorAvatar actor={{ type: "person", id: m.userId }} name={m.name} size="xs" />,
                  }))}
                />
              </li>
            )}
          </ul>
        </div>
        <p className="pu-rule muted">{t("peopleUsage.limits.rule")}</p>
        <div className="pu-when">
          <b id="pu-when">{t("peopleUsage.limits.whenTitle")}</b>
          <RadioGroup
            value={draft.onLimit}
            onValueChange={(v) => set({ onLimit: v })}
            aria-labelledby="pu-when"
            className="pu-radios"
          >
            {(["block", "notify"] as const).map((v) => (
              <label key={v} htmlFor={`pu-on-${v}`} className="pu-radio">
                <Radio value={v} id={`pu-on-${v}`} />
                {t(`peopleUsage.limits.${v}`)}
              </label>
            ))}
          </RadioGroup>
          <label htmlFor="pu-warn" className="pu-radio">
            <Checkbox id="pu-warn" checked={draft.warn} onCheckedChange={(on) => set({ warn: on === true })} />
            {t("peopleUsage.limits.warn")}
            <span className="muted">{t("peopleUsage.limits.warnHint")}</span>
          </label>
        </div>
        {editable && (
          <div className="pu-save">
            <Button
              variant="primary"
              loading={save.isPending}
              onClick={() =>
                save.mutate([draft], {
                  onSuccess: (saved) => {
                    setDraft(saved);
                    toast.show(t("peopleUsage.limits.saved"));
                  },
                  onError: (e) => toast.show(errorText(t, e), "error"),
                })
              }
            >
              {t("common.save")}
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}

/** Seu uso: the viewer's own month, in percentages of their limit (never money). */
export function MyUsage() {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const usage = usePersonUsage(org.id, me.user.id);
  if (usage.isLoading) return <LoadingList count={4} avatar={false} trailing />;
  if (!usage.data) return <ErrorState error={usage.error} onRetry={() => void usage.refetch()} />;
  const data = usage.data;
  const l = data.limit;
  const renews = formatShortDate(i18n.language, data.renewsAt);
  return (
    <>
      <Card className="pu-mine">
        <h3 className="pu-title">
          {l.percent === null
            ? t("peopleUsage.mine.noLimit")
            : t("peopleUsage.mine.title", { percent: Math.round(l.percent) })}
        </h3>
        {l.percent !== null && (
          <div className="pu-meter" data-state={l.state}>
            <Meter value={Math.min(100, l.percent)} max={100} label={`${Math.round(l.percent)}%`} marks={[80]} />
          </div>
        )}
        <p className="muted pu-mine__line">
          {t("peopleUsage.mine.renews", { date: renews })}
          {l.state === "near" || l.state === "at" ? ` ${t("peopleUsage.mine.near")}` : ""}
        </p>
        <h4 className="pu-h4">{t("peopleUsage.drawer.days")}</h4>
        <DaysChart data={data} money={false} />
      </Card>
      <Card className="pu-mine">
        <h4 className="pu-h4">{t("peopleUsage.mine.recent")}</h4>
        <RecentList data={data} />
      </Card>
    </>
  );
}

/**
 * The card an agent posts in place of an answer when the person behind its run is at their monthly limit: for that
 * person, Pedir mais and Ver meu uso; anyone else reads who reached it. A raise or a refusal moves it.
 */
export function PersonLimitCardView({ card }: { message: Message; card: PersonLimitCard }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [asked, setAsked] = useState(false);
  const [pending, setPending] = useState(false);
  const mine = card.userId === me.user.id;
  const date = formatShortDate(i18n.language, card.renewsAt);
  const by = card.byUserId ? (dir.memberById.get(card.byUserId)?.name ?? t("channel.unknownPerson")) : "";
  const who = card.userId ? (dir.memberById.get(card.userId)?.name ?? t("channel.unknownPerson")) : "";
  const ask = async () => {
    setPending(true);
    try {
      await api.orgs.requestMoreUsage(org.id);
      setAsked(true);
      void qc.invalidateQueries({ queryKey: keys.personUsage(org.id, me.user.id) });
    } catch (error) {
      toast.show(errorText(t, error), "error");
    } finally {
      setPending(false);
    }
  };
  if (card.state === "raised") {
    return (
      <div className="waitcard" data-done>
        <span className="waitcard__top ac-iconline">
          <Icon name="check" size={16} />
          <span>
            {mine ? t("peopleUsage.card.raised", { name: by }) : t("peopleUsage.card.raisedOther", { name: by })}
          </span>
        </span>
      </div>
    );
  }
  return (
    <div className="waitcard">
      <span className="waitcard__top ac-iconline">
        <Icon name="pause" size={16} />
        <span>{mine ? t("peopleUsage.card.title") : t("peopleUsage.card.other", { name: who })}</span>
      </span>
      {mine && (
        <>
          <span className="small muted">
            {card.state === "refused"
              ? t("peopleUsage.card.refused", { name: by, date })
              : t("peopleUsage.card.text", { date })}
          </span>
          <span className="waitcard__acts">
            {card.state !== "refused" && (
              <Button size="sm" variant="primary" icon="arrowUp" loading={pending} disabled={asked} onClick={ask}>
                {asked ? t("peopleUsage.card.asked") : t("peopleUsage.card.ask")}
              </Button>
            )}
            <Link
              to="/org/$orgId/settings/$section"
              params={{ orgId: org.id, section: "usage" }}
              className="ac-btn ac-btn--sm"
            >
              {t("peopleUsage.card.see")}
            </Link>
          </span>
        </>
      )}
    </div>
  );
}

/**
 * A person's request for more, in the inbox of who decides: "Aumentar para US$ X este mês", "Recusar" and their
 * month. Gone once someone answered (the notice resolves).
 */
export function UsageLimitActions({ n }: { n: AppNotification }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const raise = useRaisePersonLimit(org.id);
  const refuse = useRefuseMoreUsage(org.id);
  const toast = useToast();
  const userId = n.source.userId;
  if (n.latest.statusTo !== "request" || !userId || n.doneAt) return null;
  const to = n.latest.raiseToUsd;
  const fail = (e: unknown) => toast.show(errorText(t, e), "error");
  return (
    <span className="pu-asks ac-acts">
      {to !== undefined && (
        <Button
          size="sm"
          variant="primary"
          loading={raise.isPending}
          onClick={(e) => {
            e.stopPropagation();
            raise.mutate([userId, to], { onError: fail });
          }}
        >
          {t("peopleUsage.actions.raise", { amount: formatUsd(i18n.language, to) })}
        </Button>
      )}
      <Button
        size="sm"
        loading={refuse.isPending}
        onClick={(e) => {
          e.stopPropagation();
          refuse.mutate([userId], { onError: fail });
        }}
      >
        {t("peopleUsage.actions.refuse")}
      </Button>
      <Link
        to="/org/$orgId/settings/$section"
        params={{ orgId: org.id, section: "usage" }}
        search={{ person: userId }}
        className="ac-link pu-asks__see"
        onClick={(e) => e.stopPropagation()}
      >
        {t("peopleUsage.actions.see")}
      </Link>
    </span>
  );
}
