import {
  Avatar,
  Button,
  EmptyState,
  FilterChip,
  Icon,
  type IconName,
  SearchInput,
  Segmented,
  WorkSweep,
} from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useForumAction, useForumTopics } from "@/api/queries";
import type { ForumFilter, ForumTopic } from "@/api/types";
import { AgentAvatar } from "@/components/AgentAvatar";
import {
  deadlineLabel,
  ForumStatusChip,
  NewTopicDialog,
  type NewTopicPreset,
  SeatAvatar,
  TEMPLATES,
  TopicTrack,
  useForumWho,
  useOrigin,
} from "@/components/Forum";
import { useActorFilterOptions, useFilterCopy } from "@/components/filters";
import { ErrorState, LoadingCards } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { relativeTime } from "@/lib/format";
import {
  byActivity,
  decisionLine,
  type ForumNeed,
  filterTopics,
  isEnded,
  liveNow,
  matchTopic,
  needsOf,
  nextSeat,
  ownerOf,
  turnNow,
} from "@/lib/forum";
import { can } from "@/lib/permissions";
import "./forum.css";

export { filterTopics } from "@/lib/forum";

const FILTERS: ForumFilter[] = ["open", "done", "mine"];

/** Fórum (telas/Forum.html): who is discussing now, what needs me, and every topic in aligned rows. */
export function ForumPage() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const who = useForumWho();
  const topics = useForumTopics(org.id);
  const [filter, setFilter] = useState<ForumFilter>("open");
  const [agents, setAgents] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState<{ preset?: NewTopicPreset } | null>(null);
  const copy = useFilterCopy();
  const agentOptions = useActorFilterOptions().filter((o) => o.value.startsWith("agent:"));
  const all = [...(topics.data ?? [])].sort(byActivity);
  const ids = agents.map((a) => a.slice("agent:".length));
  const visible = all.filter((tp) => matchTopic(tp, q, ids, who.agentName));
  const lives = liveNow(visible, me.user.id);
  const needs = visible.map((tp) => needsOf(tp, me.user.id)).filter((n): n is ForumNeed => n !== null);
  const counts = Object.fromEntries(FILTERS.map((f) => [f, filterTopics(all, f, me.user.id).length])) as Record<
    ForumFilter,
    number
  >;
  const shown = filterTopics(visible, filter, me.user.id);
  // "N" opens "Novo tópico", "/" the search (not while typing or in a dialog).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest("input, textarea, [contenteditable], [role=dialog], [role=menu], [role=listbox]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        setCreating({});
      } else if (e.key === "/") {
        e.preventDefault();
        document.querySelector<HTMLInputElement>(".forum-tools__search input")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const empty = topics.isSuccess && all.length === 0;
  return (
    <div className="page forum">
      <header className="forum-head">
        <div>
          <h1>{t("forum.title")}</h1>
          <p className="forum-head__sub">{t("forum.subtitle")}</p>
          <p className="forum-head__guard">
            <Icon name="shield" size={14} />
            <span>{t("forum.guard")}</span>
          </p>
        </div>
        <Button variant="primary" icon="plus" kbd={["N"]} onClick={() => setCreating({})}>
          {t("forum.new")}
        </Button>
      </header>
      {topics.isLoading && <LoadingCards count={3} />}
      {topics.isError && !topics.data && <ErrorState error={topics.error} onRetry={() => void topics.refetch()} />}
      {empty && (
        <div className="forum-empty">
          <EmptyState sky title={t("forum.empty.title")}>
            {t("forum.empty.text")}
          </EmptyState>
          <div className="forum-tpls">
            {TEMPLATES.map((x) => (
              <button
                key={x.key}
                type="button"
                className="forum-tpl"
                onClick={() =>
                  setCreating({
                    preset: { goal: t(`forum.form.templates.${x.key}.goal`), rounds: x.rounds, format: x.format },
                  })
                }
              >
                <span className="forum-tpl__icon">
                  <Icon name={x.icon} size={18} />
                </span>
                <span>
                  <b>{t(`forum.form.templates.${x.key}.title`)}</b>
                  <small>{t(`forum.form.templates.${x.key}.text`)}</small>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      {!empty && topics.data && (
        <>
          {lives.length > 0 && (
            <section className="forum-group" aria-labelledby="forum-live-h">
              <div className="forum-gh">
                <h2 id="forum-live-h">{t("forum.liveNow")}</h2>
                <span className="forum-gh__n">{lives.length}</span>
              </div>
              <div className="forum-lvs">
                {lives.map((tp) => (
                  <LiveCard key={tp.id} topic={tp} />
                ))}
              </div>
            </section>
          )}
          {needs.length > 0 && (
            <section className="forum-group" aria-labelledby="forum-needs-h">
              <div className="forum-gh">
                <h2 id="forum-needs-h">{t("forum.needsYou")}</h2>
                <span className="forum-gh__n">{needs.length}</span>
              </div>
              <div className="forum-list">
                {needs.map((n) => (
                  <NeedRow key={n.topic.id} need={n} />
                ))}
              </div>
            </section>
          )}
          <div className="forum-tools">
            <Segmented
              label={t("forum.filters")}
              value={filter}
              onValueChange={setFilter}
              options={FILTERS.map((f) => ({
                value: f,
                label: (
                  <>
                    {t(`forum.filter.${f}`)}
                    <span className="forum-seg-n">{counts[f]}</span>
                  </>
                ),
              }))}
            />
            <FilterChip
              label={t("forum.agentFilter")}
              icon="agent"
              multiple
              options={agentOptions}
              value={agents}
              onChange={setAgents}
              valueText={(o) => o.label}
              countText={(n) => t("forum.agentCount", { count: n })}
              clearLabel={copy.clearOf(t("forum.agentFilter"))}
            />
            <span className="forum-grow" />
            <SearchInput
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("forum.search")}
              aria-label={t("forum.search")}
              className="forum-tools__search"
            />
          </div>
          {shown.length > 0 ? (
            <section className="forum-group" aria-labelledby="forum-list-h">
              <div className="forum-gh">
                <h2 id="forum-list-h">{t(`forum.listTitle.${filter}`)}</h2>
                <span className="forum-gh__n">{shown.length}</span>
              </div>
              <div className="forum-list">
                {shown.map((tp) => (
                  <TopicRow key={tp.id} topic={tp} />
                ))}
              </div>
            </section>
          ) : (
            <div className="forum-nores">
              <Icon name="search" />
              <span>{t("forum.emptyFilter")}</span>
              <Button
                size="sm"
                onClick={() => {
                  setAgents([]);
                  setQ("");
                }}
              >
                {t("forum.clearFilters")}
              </Button>
            </div>
          )}
        </>
      )}
      <NewTopicDialog open={creating !== null} onClose={() => setCreating(null)} preset={creating?.preset} />
    </div>
  );
}

/** "Ada está escrevendo", "Sua vez", "Esperando Marina", "Theo está escrevendo a síntese". */
export function useLiveLine() {
  const { t } = useTranslation();
  const who = useForumWho();
  return (tp: ForumTopic) => {
    const now = turnNow(tp);
    if (!now) return "";
    if (now.kind === "stalled") {
      const name = who.agentName(now.agentId);
      return now.synthesis || !name
        ? t("forum.live.stalledSynthesis")
        : t("forum.live.stalled", { name, of: who.g(name).of });
    }
    if (now.kind === "synthesis") return t("forum.live.synthesis", { name: who.agentName(now.agentId) });
    if (now.kind === "person")
      return now.userId === who.me
        ? t("forum.live.yourTurn")
        : t("forum.live.waiting", { name: who.personName(now.userId) });
    return t(now.writing ? "forum.live.writing" : "forum.live.reading", { name: who.agentName(now.agentId) });
  };
}

/** A topic being discussed now: who speaks, the round, the track, who is next, the deadline. */
function LiveCard({ topic: tp }: { topic: ForumTopic }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const who = useForumWho();
  const line = useLiveLine();
  const now = turnNow(tp);
  const next = nextSeat(tp);
  const owner = ownerOf(tp);
  const writing = (now?.kind === "agent" && now.writing) || now?.kind === "synthesis";
  const speaker = now?.kind === "person" ? null : now && "agentId" in now ? now.agentId : owner;
  return (
    <Link to="/org/$orgId/forum/$topicId" params={{ orgId: org.id, topicId: tp.id }} className="forum-lv">
      <span className="forum-lv__h">
        {now?.kind === "person" ? (
          <Avatar
            kind="person"
            name={who.personName(now.userId)}
            imageUrl={who.dir.memberById.get(now.userId)?.image}
          />
        ) : speaker ? (
          <AgentAvatar agentId={speaker} name={who.agentName(speaker)} state={writing ? "writing" : "thinking"} />
        ) : null}
        <span className="forum-lv__t">
          <small>
            <b>{line(tp)}</b> · {t("forum.roundOf", { round: Math.max(1, tp.round), rounds: tp.rounds })}
          </small>
          <span className="forum-lv__ti">{tp.title}</span>
        </span>
      </span>
      <TopicTrack topic={tp} size="mid" />
      <span className="forum-lv__f">
        <span className="forum-lv__nx">
          {next ? (
            <>
              <SeatAvatar seat={next} size="xs" mode="next" />
              {t("forum.live.next", { name: who.seatName(next) })}
            </>
          ) : (
            <>
              {owner && <SeatAvatar seat={{ type: "agent", id: owner }} size="xs" />}
              {t("forum.live.thenSynthesis")}
            </>
          )}
        </span>
        <span className="forum-grow" />
        {tp.deadline && <span>{t("forum.until", { when: deadlineLabel(t, i18n.language, tp.deadline) })}</span>}
      </span>
      {writing && speaker && <WorkSweep color={who.colorOf(speaker)} />}
    </Link>
  );
}

const NEED_ICON: Record<ForumNeed["kind"], IconName> = {
  turn: "flag",
  issues: "issues",
  budget: "coin",
  stalled: "pause",
};

/** One line of "Precisa de você": the reason and one action. */
function NeedRow({ need }: { need: ForumNeed }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const who = useForumWho();
  const navigate = useNavigate();
  const action = useForumAction(org.id);
  const tp = need.topic;
  const open = (hash?: string) =>
    void navigate({ to: "/org/$orgId/forum/$topicId", params: { orgId: org.id, topicId: tp.id }, hash });
  const plan = tp.synthesis?.format === "plan" || tp.format === "plan";
  const parent = tp.origin.kind === "issue" ? tp.origin.issueNumber : null;
  const text = (() => {
    switch (need.kind) {
      case "turn":
        return tp.deadline
          ? t("forum.need.turnDeadline", { round: tp.round, when: deadlineLabel(t, i18n.language, tp.deadline) })
          : t("forum.need.turn", { round: tp.round });
      case "issues":
        return parent
          ? t("forum.need.subIssues", { count: need.count, number: parent })
          : t(plan ? "forum.need.planIssues" : "forum.need.issues", { count: need.count });
      case "budget": {
        const name = who.agentName(need.agentId);
        return t("forum.need.budget", { name, The: who.g(name).The });
      }
      default:
        return t("forum.need.stalled");
    }
  })();
  const admin = can(org.role, "manage_agents");
  return (
    // biome-ignore lint/a11y/useSemanticElements: a row with its own buttons inside (a link can't hold them)
    <div
      className="forum-nd"
      role="button"
      tabIndex={0}
      onClick={(e) => {
        if ((e.target as Element).closest("button, a")) return;
        open();
      }}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          open();
        }
      }}
    >
      <span className="forum-nd__ic">
        {need.kind === "budget" ? (
          <SeatAvatar seat={{ type: "agent", id: need.agentId }} size="sm" mode="sleep" />
        ) : (
          <Icon name={NEED_ICON[need.kind]} size={18} />
        )}
      </span>
      <span className="forum-nd__t">
        <b>{need.kind === "turn" ? t("forum.need.turnTitle", { title: tp.title }) : tp.title}</b>
        <small>{text}</small>
      </span>
      <span className="forum-nd__acts">
        {need.kind === "turn" && (
          <Button size="sm" variant="primary" onClick={() => open("forum-live")}>
            {t("forum.need.speak")}
          </Button>
        )}
        {need.kind === "issues" && (
          <Button size="sm" variant="primary" icon="issues" onClick={() => open("forum-issues")}>
            {t("forum.need.review")}
          </Button>
        )}
        {need.kind === "budget" && admin && (
          <Button asChild size="sm">
            <Link
              to="/org/$orgId/agents/$agentId"
              params={{ orgId: org.id, agentId: need.agentId }}
              search={{ tab: "settings", sec: "budget" }}
            >
              <Icon name="coin" size={16} />
              {t("forum.need.seeBudget")}
            </Link>
          </Button>
        )}
        {need.kind === "stalled" && (
          <Button
            size="sm"
            icon="play"
            loading={action.isPending}
            onClick={() => action.mutate({ type: "resume", topicId: tp.id })}
          >
            {t("forum.need.resume")}
          </Button>
        )}
      </span>
    </div>
  );
}

/** A topic in the list, in fixed columns: title (goal, decision or why it stopped), table, track, status, origin. */
function TopicRow({ topic: tp }: { topic: ForumTopic }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const who = useForumWho();
  const origin = useOrigin()(tp);
  const line = useLiveLine();
  const decision = decisionLine(tp);
  const ago = relativeTime(t, i18n.language, tp.lastActivityAt);
  const when = isEnded(tp)
    ? ago
    : `${t("forum.roundOf", { round: Math.max(1, tp.round), rounds: tp.rounds })} · ${ago}`;
  const people = tp.userIds.filter((id) => !tp.seats.some((s) => s.type === "person" && s.id === id));
  return (
    <Link
      to="/org/$orgId/forum/$topicId"
      params={{ orgId: org.id, topicId: tp.id }}
      className="forum-tr"
      data-status={tp.status}
      aria-label={tp.title}
    >
      <span className="forum-tr__ti">
        <b title={tp.title}>{tp.title}</b>
        {tp.status === "done" && decision ? (
          <small className="forum-tr__dec">
            <Icon name="check" size={14} />
            <span>{decision}</span>
          </small>
        ) : tp.status === "canceled" ? (
          <small>
            <Icon name="block" size={14} />
            <span>{t("forum.row.canceled")}</span>
          </small>
        ) : tp.status === "stalled" ? (
          <small>
            <Icon name="pause" size={14} />
            <span>{line(tp)}</span>
          </small>
        ) : (
          <small>
            <span>{tp.goal}</span>
          </small>
        )}
      </span>
      <span className="forum-tr__who" aria-hidden="true">
        {tp.agentIds.slice(0, 4).map((id) => (
          <AgentAvatar key={id} agentId={id} name={who.agentName(id)} size="xs" state="idle" />
        ))}
        {[...tp.seats.filter((s) => s.type === "person").map((s) => s.id), ...people].slice(0, 3).map((id) => (
          <Avatar
            key={id}
            kind="person"
            size="xs"
            name={who.personName(id)}
            imageUrl={who.dir.memberById.get(id)?.image}
          />
        ))}
      </span>
      <span className="forum-tr__trk">
        <TopicTrack topic={tp} size="mini" />
      </span>
      <span className="forum-tr__st">
        <ForumStatusChip topic={tp} />
      </span>
      <span className="forum-tr__ori">
        <span title={origin.text}>
          {origin.agentId ? (
            <AgentAvatar agentId={origin.agentId} name={who.agentName(origin.agentId)} size="xs" state="idle" />
          ) : (
            origin.icon && <Icon name={origin.icon} size={14} />
          )}
          {origin.short}
        </span>
        <small>{when}</small>
      </span>
    </Link>
  );
}
