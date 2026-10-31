import type { FormerAgent, Team, TeamAgent, TeamConsultation } from "@agenteschat/client";
import { useAiStatus, useCatalog, useFormerAgents, useTeam } from "@agenteschat/client";
import { relativeTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { aiStateOf } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { excerpt } from "@agenteschat/client/lib/text";
import {
  Avatar,
  Button,
  Card,
  Chip,
  EmptyState,
  Icon,
  type IconName,
  PixelSky,
  PixelSpinner,
  pixelOf,
  prefersReducedMotion,
  SKY_TONES,
  type SkyFrame,
  spriteTone,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { DeleteAgentDialog } from "@/components/DeleteAgentDialog";
import { ErrorState, LoadingCards } from "@/components/Loading";
import { NoAiChip } from "@/components/NoAi";
import { useOrg } from "@/components/org-context";
import { colorOf } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";
import { useTheme } from "@/lib/theme";
import "./team.css";

/*
 * Equipe: the agents as live sprites in
 * the pixel sky, in clusters around the person responsible for them. A pixel
 * line joins agents that consulted each other in the last day; a new
 * consultation lights its line for a moment. Tap an agent for its card.
 */

/** Capability keys shown as chips (context, memory, skills and workspace setup are on every agent: no news). */
const CAPS = {
  drive: "drive",
  issues: "issues",
  calendar: "calendar",
  schedule: "routines",
  forum: "message",
  wiki: "book",
  sandbox: "computer",
  desktop: "pointer",
  browser: "globe",
  database: "database",
  github: "repo",
  sentry: "alert",
  linear: "layers",
  gdrive: "cloud",
  mail: "mail",
  custom: "plug",
} as const satisfies Record<string, IconName>;
type CapKey = keyof typeof CAPS;
/** Abilities that are another company's service, by its connector: drawn with the service's own mark. */
const CAP_CONNECTOR: Partial<Record<CapKey, string>> = {
  github: "github",
  sentry: "sentry",
  linear: "linear",
  gdrive: "drive",
};
const HIDDEN_CAPS = new Set(["context", "memory", "skills", "setup"]);
/** "What it does" on its card: the first line of its instructions, in whole sentences while they fit. */
const SUMMARY_MAX = 160;
const isCap = (k: string): k is CapKey => k in CAPS;

/** How long a new consultation's line stays lit, in ms. */
const HOT_MS = 2600;
const PIXEL = 4;
const NO_OWNER = "";

interface Spot {
  id: string;
  x: number;
  y: number;
}
interface Label {
  key: string;
  name: string;
  image: string | null;
  x: number;
  y: number;
}

/** Clusters per person: 4 across on wide screens, 2 per row on phones; the card's side stays free. */
function layout(team: Team, w: number, h: number, narrow: boolean, cardOpen: boolean, noOwner: string) {
  const people = new Map(team.people.map((p) => [p.id, p]));
  const groups = new Map<string, TeamAgent[]>();
  for (const a of team.agents) {
    const key = a.ownerUserId && people.has(a.ownerUserId) ? a.ownerUserId : NO_OWNER;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  // People in the order their first agent was made; agents without a person last.
  const order = [...groups.keys()].sort((a, b) => (a === NO_OWNER ? 1 : b === NO_OWNER ? -1 : 0));
  const cols = narrow ? Math.min(2, order.length) : Math.min(4, order.length);
  const rows = Math.ceil(order.length / Math.max(1, cols));
  const left = cardOpen && !narrow ? Math.min(0.5, (16 + 360 + 40) / w) : 0;
  const spots: Spot[] = [];
  const labels: Label[] = [];
  order.forEach((key, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const u = left + ((col + 0.5) / cols) * (1 - left - 0.02);
    const stagger = narrow ? 0 : col % 2 === 0 ? 0.04 : -0.06;
    const v = (row + 0.55) / rows + stagger / rows;
    const cx = u * w;
    const cy = v * h;
    const list = groups.get(key) ?? [];
    const n = list.length;
    const r = n === 1 ? 0 : (narrow ? 56 : 84) + Math.max(0, n - 6) * 8;
    const person = people.get(key);
    labels.push({
      key: key || "none",
      name: person?.name ?? noOwner,
      image: person?.image ?? null,
      x: cx,
      // Above the top sprite: half its height, room for a hat, a gap and the label itself.
      y: cy - (n > 1 ? r * 0.7 : 0) - (narrow ? 72 : 84),
    });
    list.forEach((a, k) => {
      const ang = -Math.PI / 2 + (k / n) * Math.PI * 2;
      spots.push({ id: a.id, x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r * 0.7 });
    });
  });
  return { spots, labels };
}

/** Pixel line in the sky buffer, from (x0, y0) to (x1, y1) in screen pixels. */
function plot(f: SkyFrame, x0: number, y0: number, x1: number, y1: number, col: number, dashed: boolean) {
  const ax = Math.round(x0 / PIXEL);
  const ay = Math.round(y0 / PIXEL);
  const bx = Math.round(x1 / PIXEL);
  const by = Math.round(y1 / PIXEL);
  const n = Math.max(Math.abs(bx - ax), Math.abs(by - ay)) || 1;
  for (let i = 0; i <= n; i++) {
    if (dashed && i % 3) continue;
    const x = Math.round(ax + ((bx - ax) * i) / n);
    const y = Math.round(ay + ((by - ay) * i) / n);
    if (x >= 0 && y >= 0 && x < f.w && y < f.h) f.buf[y * f.w + x] = col;
  }
}
/** The 3×3 pixel that travels a lit line: to the agent asked, then back with the answer. */
function puck(f: SkyFrame, x0: number, y0: number, x1: number, y1: number, at: number, col: number) {
  const hx = Math.round((x0 + (x1 - x0) * at) / PIXEL);
  const hy = Math.round((y0 + (y1 - y0) * at) / PIXEL);
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const x = hx + dx;
      const y = hy + dy;
      if (x >= 0 && y >= 0 && x < f.w && y < f.h) f.buf[y * f.w + x] = col;
    }
}

const WHITE = pixelOf("#ffffff");
/** The night sky of the dark theme. */
const NIGHT_TONES = ["#04112b", "#071c45", "#0a2b66", "#0e3d8c", "#1452b0", "#2b74e6", "#4b93ff", "#78b4ff"];
const starAt = (x: number, y: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

export function TeamPage() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const team = useTeam(org.id);
  // Asked with the page, so an agent's card opens already saying whether it can work, with its services' marks.
  useAiStatus(org.id);
  useCatalog();
  const data = team.data;
  const working = data?.agents.filter((a) => a.busy).length ?? 0;
  // Archived agents have no page: admins delete them for good here (ADR 0082).
  const admin = can(org.role, "manage_agents");
  const former = useFormerAgents(org.id);
  const archived = (former.data ?? []).filter((a) => !a.deleted);
  const [deleting, setDeleting] = useState<FormerAgent | null>(null);
  return (
    <div className="page team">
      <header className="team-head">
        <div>
          <h1>{t("team.title")}</h1>
          {data && data.agents.length > 0 && (
            <p className="team-head__sub">
              {t("team.subtitle", { count: data.agents.length })} {working > 0 && t("team.working", { count: working })}
            </p>
          )}
        </div>
        {admin && (
          <div className="row team-head__actions">
            <Button asChild icon="archiveBox">
              <Link to="/org/$orgId/settings/$section" params={{ orgId: org.id, section: "import" }}>
                {t("shell.importAgents")}
              </Link>
            </Button>
            <Button asChild variant="primary" icon="plus">
              <Link to="/org/$orgId/agents/new" params={{ orgId: org.id }}>
                {t("shell.createAgent")}
              </Link>
            </Button>
          </div>
        )}
      </header>
      {team.isLoading && <LoadingCards count={2} />}
      {team.isError && !data && <ErrorState error={team.error} onRetry={() => void team.refetch()} />}
      {data && data.agents.length === 0 && (
        <EmptyState sky title={t("team.emptyTitle")}>
          {t("team.empty")}
        </EmptyState>
      )}
      {data && data.agents.length > 0 && (
        <>
          <TeamSky team={data} />
          <Card className="team-feed">
            <div className="team-feed__head">
              <Icon name="chart" size={16} />
              <h2>{t("team.feedTitle")}</h2>
              <span className="team-feed__window">{t("team.feedWindow")}</span>
            </div>
            {data.consultations.length === 0 ? (
              <p className="team-feed__empty">{t("team.feedEmpty")}</p>
            ) : (
              <div className="team-feed__grid">
                {data.consultations.slice(0, 9).map((c, i) => (
                  <FeedItem key={c.id} team={data} c={c} fresh={i === 0} locale={i18n.language} />
                ))}
              </div>
            )}
          </Card>
        </>
      )}
      {admin && archived.length > 0 && (
        <Card className="team-archived">
          <div className="team-feed__head">
            <Icon name="archive" size={16} />
            <h2>{t("team.archived")}</h2>
          </div>
          {archived.map((a) => (
            <div key={a.id} className="member-row">
              <AgentAvatar agentId={a.id} size="sm" name={a.name} />
              <span className="list-col">
                <b>{a.name}</b>
                {a.role && <span className="small muted">{a.role}</span>}
              </span>
              <Button
                size="sm"
                variant="ghost"
                icon="trash"
                aria-label={t("agentPage.delete.action", agentGrammar(t, a.name))}
                onClick={() => setDeleting(a)}
              >
                {t("agentPage.delete.button")}
              </Button>
            </div>
          ))}
        </Card>
      )}
      <DeleteAgentDialog agent={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}

function FeedItem({ team, c, fresh, locale }: { team: Team; c: TeamConsultation; fresh: boolean; locale: string }) {
  const { t } = useTranslation();
  const from = team.agents.find((a) => a.id === c.askerAgentId);
  const to = team.agents.find((a) => a.id === c.targetAgentId);
  if (!from || !to) return null;
  const status = (["open", "answered", "expired", "failed"] as const).find((s) => s === c.status) ?? "answered";
  const live = Date.now() - new Date(c.createdAt).getTime() < 60_000;
  return (
    <div className="team-feed__item" data-fresh={fresh && live ? "" : undefined}>
      <span className="team-feed__pair" aria-hidden="true">
        <AgentAvatar agentId={from.id} name={from.name} size="sm" />
        <Icon name="arrowRight" size={14} />
        <AgentAvatar agentId={to.id} name={to.name} size="sm" />
      </span>
      <span className="team-feed__text">
        <span>
          {t("team.asked", { from: from.name, to: to.name })} ·{" "}
          <time dateTime={c.createdAt}>{relativeTime(t, locale, c.createdAt)}</time>
        </span>
        <span className="team-feed__status">{t(`team.consultation.${status}`)}</span>
      </span>
    </div>
  );
}

function TeamSky({ team }: { team: Team }) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [selected, setSelected] = useState<string | null>(null);
  const narrow = size.w > 0 && size.w < 640;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(read) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  const agent = team.agents.find((a) => a.id === selected) ?? null;
  const { spots, labels } = useMemo(
    () => layout(team, size.w, size.h, narrow, !!agent, t("team.noOwner")),
    [team, size.w, size.h, narrow, agent, t],
  );

  // New consultations (after the first load) light their line and wake both agents for a moment.
  const seen = useRef<Set<string> | null>(null);
  const hot = useRef<{ from: string; to: string; t0: number }[]>([]);
  const [hotIds, setHotIds] = useState<Set<string>>(new Set());
  const [hint, setHint] = useState<string | null>(null);
  useEffect(() => {
    const ids = team.consultations.map((c) => c.id);
    if (!seen.current) {
      seen.current = new Set(ids);
      return;
    }
    const fresh = team.consultations.filter((c) => !seen.current?.has(c.id));
    for (const id of ids) seen.current.add(id);
    if (fresh.length === 0) return;
    const now = performance.now();
    for (const c of fresh) hot.current.push({ from: c.askerAgentId, to: c.targetAgentId, t0: now });
    const latest = fresh[0];
    const name = (id: string) => team.agents.find((a) => a.id === id)?.name ?? "";
    if (latest) setHint(t("team.asked", { from: name(latest.askerAgentId), to: name(latest.targetAgentId) }));
    setHotIds(new Set(fresh.flatMap((c) => [c.askerAgentId, c.targetAgentId])));
    const timer = setTimeout(() => setHotIds(new Set()), HOT_MS + 600);
    return () => clearTimeout(timer);
  }, [team, t]);

  // Read on every sky frame: the latest positions, pairs and selection.
  const dark = useTheme().resolved === "dark";
  const live = useRef({ spots, team, selected, dark });
  live.current = { spots, team, selected, dark };

  useEffect(() => {
    if (!agent) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSelected(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [agent]);

  const skyOptions = useMemo(
    () => ({
      pixel: PIXEL,
      palette: () => (live.current.dark ? NIGHT_TONES : SKY_TONES),
      light: 0.16,
      base: (u: number, v: number, tt: number) =>
        (live.current.dark ? 0.15 + v * 0.35 : 0.25 + v * 0.55) +
        0.08 * Math.sin(u * 6 + tt * 0.15) * Math.sin(v * 4 - tt * 0.1),
      // A soft glow under each agent, so clusters read as places in the sky.
      blobs: (): [number, number, number, number][] => {
        const { spots: s } = live.current;
        const w = box.current?.clientWidth || 1;
        const h = box.current?.clientHeight || 1;
        return s.map((p) => [p.x / w, p.y / h, 0.05, 0.14]);
      },
      after: (f: SkyFrame) => {
        const { spots: s, team: tm, selected: sel, dark: dk } = live.current;
        const L = f.tones.length - 1;
        if (dk) {
          // A few twinkling stars in the upper sky.
          for (let y = 0; y < f.h * 0.7; y++)
            for (let x = 0; x < f.w; x++) {
              const h = starAt(x, y);
              if (h > 0.992 && Math.sin(f.t * 2 + h * 50) > -0.2) f.buf[y * f.w + x] = f.tones[L] ?? WHITE;
            }
        }
        // Lines contrast with the sky: light on the night, deep on the day.
        const faint = f.tones[dk ? 5 : 2] ?? WHITE;
        const strong = dk ? WHITE : (f.tones[0] ?? WHITE);
        const at = (id: string) => s.find((p) => p.id === id);
        const seenPairs = new Set<string>();
        for (const c of tm.consultations) {
          const key = [c.askerAgentId, c.targetAgentId].sort().join("|");
          if (seenPairs.has(key)) continue;
          seenPairs.add(key);
          const a = at(c.askerAgentId);
          const b = at(c.targetAgentId);
          if (!a || !b) continue;
          const focus = !!sel && (c.askerAgentId === sel || c.targetAgentId === sel);
          plot(f, a.x, a.y, b.x, b.y, focus ? strong : faint, !focus);
        }
        const now = performance.now();
        hot.current = hot.current.filter((p) => now - p.t0 < HOT_MS);
        for (const p of hot.current) {
          const a = at(p.from);
          const b = at(p.to);
          if (!a || !b) continue;
          const u = (now - p.t0) / HOT_MS;
          let k = u < 0.5 ? u * 2 : 2 - u * 2;
          k = k * k * (3 - 2 * k);
          const asker = tm.agents.find((x) => x.id === p.from);
          plot(f, a.x, a.y, b.x, b.y, pixelOf(spriteTone(colorOf(asker))), false);
          if (!prefersReducedMotion()) puck(f, a.x, a.y, b.x, b.y, k, WHITE);
        }
      },
    }),
    [],
  );

  return (
    <div
      className="team-sky"
      ref={box}
      data-narrow={narrow ? "" : undefined}
      data-small={labels.length <= 2 ? "" : undefined}
    >
      <PixelSky options={skyOptions} />
      <section className="team-sky__stage" aria-label={t("team.skyLabel")}>
        {labels.map((l) => (
          <span key={l.key} className="team-sky__person" style={{ left: l.x, top: l.y }}>
            <Avatar name={l.name} size="xs" imageUrl={l.image} />
            {l.name}
          </span>
        ))}
        {spots.map((s, i) => {
          const a = team.agents.find((x) => x.id === s.id);
          if (!a) return null;
          const on = selected === a.id;
          return (
            <button
              key={a.id}
              type="button"
              className="team-sky__agent"
              style={{ left: s.x, top: s.y, "--bob-delay": `${-(i * 0.7)}s` } as CSSProperties}
              aria-pressed={on}
              aria-label={t("team.openAgent", { name: a.name })}
              onClick={() => setSelected(on ? null : a.id)}
            >
              <span className="team-sky__figure">
                <AgentAvatar
                  agentId={a.id}
                  name={a.name}
                  size={narrow ? "md" : "lg"}
                  framed={false}
                  state={hotIds.has(a.id) ? "thinking" : undefined}
                />
              </span>
              <span className="team-sky__tag">
                {(a.busy || hotIds.has(a.id)) && <PixelSpinner size={14} color={colorOf(a)} />}
                {a.name}
              </span>
            </button>
          );
        })}
      </section>
      <span className="team-sky__hint" aria-live="polite">
        <Icon name="chart" size={14} />
        {hint ?? t("team.tapHint")}
      </span>
      {agent && <AgentCard agent={agent} team={team} onClose={() => setSelected(null)} />}
    </div>
  );
}

function AgentCard({ agent, team, onClose }: { agent: TeamAgent; team: Team; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const aiStatus = useAiStatus(org.id);
  const ai = aiStateOf(aiStatus.data, agent.id);
  const dir = useDirectory(org.id);
  // The same plain words as its page's "What it does", from the instructions every member can read.
  const summary = excerpt(dir.agentById.get(agent.id)?.instructions ?? "", SUMMARY_MAX, 1);
  const owner = team.people.find((p) => p.id === agent.ownerUserId);
  const caps = agent.capabilities.filter((k) => !HIDDEN_CAPS.has(k));
  const g = agentGrammar(t, agent.name);
  const catalog = useCatalog();
  const serviceOf = (k: CapKey) => {
    const def = catalog.data?.connectors.find((c) => c.id === CAP_CONNECTOR[k]);
    return def?.iconUrl ? def : null;
  };
  return (
    <div className="team-card" role="dialog" aria-label={t("team.details", { name: agent.name })}>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        icon="close"
        className="team-card__close"
        aria-label={t("team.close")}
        onClick={onClose}
      />
      <div className="team-card__head">
        <AgentAvatar agentId={agent.id} name={agent.name} size="lg" />
        <div className="team-card__title">
          <h3>{agent.name}</h3>
          <span className="team-card__meta">
            @{agent.handle}
            {agent.role && ` · ${agent.role}`}
            {owner && ` · ${t("team.of", { name: owner.name })}`}
          </span>
          {agent.busy ? (
            <span className="team-card__status" data-busy="">
              <PixelSpinner size={14} color={colorOf(agent)} />
              {t("team.workingNow")}
            </span>
          ) : ai === "no_ai" ? (
            <NoAiChip agentId={agent.id} />
          ) : (
            // Waiting (its computer away, a plan's limit reached) can't work now either: no word, never Available.
            ai === "ready" && (
              <span className="team-card__status">
                <span className="team-card__dot" aria-hidden="true" />
                {t("team.available")}
              </span>
            )
          )}
        </div>
      </div>
      {summary && (
        <div className="team-card__sec">
          <span className="team-card__eyebrow">{t("team.does", g)}</span>
          <p className="team-card__call">{summary}</p>
        </div>
      )}
      <div className="team-card__sec">
        <span className="team-card__eyebrow">{t("team.canDo", g)}</span>
        <div className="team-card__chips">
          {caps.length === 0 && <Chip icon="message">{t("team.onlyChat")}</Chip>}
          {caps.map((k) => {
            if (!isCap(k))
              return (
                <Chip key={k} icon="plug">
                  {k.charAt(0).toUpperCase() + k.slice(1)}
                </Chip>
              );
            const service = serviceOf(k);
            return (
              <Chip key={k} icon={CAPS[k]} lead={service && <ConnectorIcon def={service} label={t(`team.cap.${k}`)} />}>
                {t(`team.cap.${k}`)}
              </Chip>
            );
          })}
        </div>
      </div>
      <div className="team-card__acts">
        {agent.canTalk && (
          <Button asChild variant="primary" size="sm" icon="message">
            <Link to="/org/$orgId/dm/agent/$agentId" params={{ orgId: org.id, agentId: agent.id }}>
              {t("team.talk")}
            </Link>
          </Button>
        )}
        <Button asChild size="sm" icon="edit">
          <Link to="/org/$orgId/agents/$agentId" params={{ orgId: org.id, agentId: agent.id }}>
            {t("team.edit")}
          </Link>
        </Button>
      </div>
    </div>
  );
}
