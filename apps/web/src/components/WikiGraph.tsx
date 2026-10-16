import { appearanceStyle, FilterToggle } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWikiGraph } from "@/api/queries";
import type { WikiGraph } from "@/api/types";
import { ErrorState, LoadingCards } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { lookOf } from "@/lib/look";

export interface Placed {
  slug: string;
  x: number;
  y: number;
}

/**
 * A small force-directed layout (no library): nodes repel, links pull,
 * everything drifts to the center. Deterministic (starts on a circle), so
 * the same graph always lands the same way.
 */
export function layoutGraph(graph: WikiGraph, width = 720, height = 460, steps = 240): Placed[] {
  const n = graph.nodes.length;
  if (n === 0) return [];
  const pos = graph.nodes.map((node, i) => {
    const a = (2 * Math.PI * i) / n;
    return {
      slug: node.slug,
      x: width / 2 + Math.cos(a) * width * 0.3,
      y: height / 2 + Math.sin(a) * height * 0.3,
      vx: 0,
      vy: 0,
    };
  });
  const index = new Map(pos.map((p, i) => [p.slug, i]));
  const edges = graph.edges
    .map((e) => [index.get(e.from), index.get(e.to)] as const)
    .filter((e): e is readonly [number, number] => e[0] !== undefined && e[1] !== undefined && e[0] !== e[1]);
  const k = Math.sqrt((width * height) / n) * 0.6;
  for (let step = 0; step < steps; step++) {
    const cool = 1 - step / steps;
    for (let i = 0; i < n; i++) {
      const a = pos[i] as (typeof pos)[number];
      for (let j = i + 1; j < n; j++) {
        const b = pos[j] as (typeof pos)[number];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = 0.1 * (i - j);
          dy = 0.1;
          d2 = dx * dx + dy * dy;
        }
        const f = (k * k) / d2;
        a.vx += dx * f * 0.02;
        a.vy += dy * f * 0.02;
        b.vx -= dx * f * 0.02;
        b.vy -= dy * f * 0.02;
      }
    }
    for (const [i, j] of edges) {
      const a = pos[i] as (typeof pos)[number];
      const b = pos[j] as (typeof pos)[number];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = ((d - k) / d) * 0.06;
      a.vx += dx * f;
      a.vy += dy * f;
      b.vx -= dx * f;
      b.vy -= dy * f;
    }
    for (const p of pos) {
      p.vx += (width / 2 - p.x) * 0.004;
      p.vy += (height / 2 - p.y) * 0.004;
      const max = 12 * cool + 1;
      p.x += Math.max(-max, Math.min(max, p.vx));
      p.y += Math.max(-max, Math.min(max, p.vy));
      p.vx *= 0.6;
      p.vy *= 0.6;
      p.x = Math.max(24, Math.min(width - 24, p.x));
      p.y = Math.max(24, Math.min(height - 24, p.y));
    }
  }
  return pos.map(({ slug, x, y }) => ({ slug, x: Math.round(x), y: Math.round(y) }));
}

/** Pages linked to `slug` (both directions). */
export const neighborsOf = (graph: WikiGraph, slug: string) =>
  new Set(graph.edges.flatMap((e) => (e.from === slug ? [e.to] : e.to === slug ? [e.from] : [])));

type Filter = "all" | "agent" | "obsidian" | `folder:${string}`;

/**
 * "Grafo": pages and their links; hover lights the neighbors, click opens;
 * filter by who wrote them (agents), where they came from (Obsidian) or the
 * top folder. `mini`: the home's preview (no filters, no labels, not interactive).
 */
export function WikiGraphView({ onOpen, mini = false }: { onOpen?: () => void; mini?: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const navigate = useNavigate();
  const graph = useWikiGraph(org.id, true);
  const [hover, setHover] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const data = graph.data;
  const filtered = useMemo<WikiGraph | null>(() => {
    if (!data) return null;
    if (filter === "all") return data;
    const keep = new Set(
      data.nodes
        .filter((n) =>
          filter === "agent"
            ? Boolean(n.agentId)
            : filter === "obsidian"
              ? n.sourceType === "obsidian"
              : (n.folder.split("/")[0] || "") === filter.slice("folder:".length),
        )
        .map((n) => n.slug),
    );
    return {
      nodes: data.nodes.filter((n) => keep.has(n.slug)),
      edges: data.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    };
  }, [data, filter]);
  const W = mini ? 520 : 960;
  const H = mini ? 200 : 560;
  const placed = useMemo(() => (filtered ? layoutGraph(filtered, W, H) : []), [filtered, W, H]);
  if (graph.isLoading) return mini ? null : <LoadingCards count={2} />;
  if (!data || !filtered) return mini ? null : <ErrorState error={graph.error} onRetry={() => void graph.refetch()} />;
  const at = new Map(placed.map((p) => [p.slug, p]));
  const near = hover ? neighborsOf(filtered, hover) : null;
  const degree = new Map<string, number>();
  for (const e of filtered.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const folders = [...new Set(data.nodes.map((n) => n.folder.split("/")[0] || ""))].filter(Boolean).sort();
  const hasObsidian = data.nodes.some((n) => n.sourceType === "obsidian");
  const hasAgents = data.nodes.some((n) => n.agentId);
  const open = (slug: string) => {
    onOpen?.();
    void navigate({ to: "/org/$orgId/wiki/$slug", params: { orgId: org.id, slug } });
  };
  const svg = (
    <svg
      className="wiki-graph__svg"
      viewBox={`0 0 ${W} ${H}`}
      role={mini ? "presentation" : "img"}
      aria-label={mini ? undefined : t("wiki.graphLabel", { count: filtered.nodes.length })}
      aria-hidden={mini || undefined}
    >
      <g className="wiki-graph__edges">
        {filtered.edges.map((e) => {
          const a = at.get(e.from);
          const b = at.get(e.to);
          if (!a || !b) return null;
          const lit = hover !== null && (e.from === hover || e.to === hover);
          return (
            <line
              key={`${e.from}>${e.to}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              data-lit={lit || undefined}
              data-dim={(hover !== null && !lit) || undefined}
            />
          );
        })}
      </g>
      {filtered.nodes.map((node) => {
        const p = at.get(node.slug);
        if (!p) return null;
        const lit = hover === node.slug || near?.has(node.slug);
        const agent = node.agentId ? dir.agentById.get(node.agentId) : undefined;
        const r = 5 + Math.sqrt(degree.get(node.slug) ?? 0) * 2.4;
        const kind = node.sourceType === "obsidian" ? "obsidian" : agent ? "agent" : "person";
        const showLabel = !mini && ((degree.get(node.slug) ?? 0) >= 2 || lit || filtered.nodes.length <= 16);
        if (mini) {
          return (
            <circle
              key={node.slug}
              className="wiki-graph__dot"
              data-kind={kind}
              cx={p.x}
              cy={p.y}
              r={r * 0.8}
              style={agent ? appearanceStyle(lookOf(agent)) : undefined}
            />
          );
        }
        return (
          // biome-ignore lint/a11y/useSemanticElements: an SVG node acting as a link
          <g
            key={node.slug}
            className="wiki-graph__node"
            data-kind={kind}
            data-lit={lit || undefined}
            data-dim={(hover !== null && !lit) || undefined}
            data-agent={agent ? "" : undefined}
            style={agent ? appearanceStyle(lookOf(agent)) : undefined}
            transform={`translate(${p.x} ${p.y})`}
            role="link"
            tabIndex={0}
            aria-label={node.title}
            onPointerEnter={() => setHover(node.slug)}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(node.slug)}
            onBlur={() => setHover(null)}
            onClick={() => open(node.slug)}
            onKeyDown={(e) => {
              if (e.key === "Enter") open(node.slug);
            }}
          >
            <circle r={r} />
            {showLabel && (
              <text y={r + 14} textAnchor="middle">
                {node.title}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
  if (mini) return svg;
  const chips: [Filter, string][] = [
    ["all", t("wiki.allPages")],
    ...(hasAgents ? ([["agent", t("wiki.graphAgents")]] as [Filter, string][]) : []),
    ...(hasObsidian ? ([["obsidian", t("wiki.fromObsidian")]] as [Filter, string][]) : []),
    ...folders.map((f) => [`folder:${f}`, f] as [Filter, string]),
  ];
  return (
    <section className="wiki-graph" aria-label={t("wiki.graph")}>
      <header className="wiki-home__head">
        <div>
          <h1 className="wiki-home__title">{t("wiki.graph")}</h1>
          <p className="muted">{t("wiki.graphText")}</p>
        </div>
      </header>
      <div className="wiki-graph__box">
        <fieldset className="wiki-graph__filter">
          <legend className="ac-visually-hidden">{t("wiki.graphFilter")}</legend>
          {chips.map(([value, label]) => (
            <FilterToggle key={value} pressed={filter === value} onPressedChange={() => setFilter(value)}>
              {label}
            </FilterToggle>
          ))}
        </fieldset>
        {svg}
        <p className="wiki-graph__legend" aria-hidden="true">
          <span data-kind="person">{t("wiki.legend.people")}</span>
          {hasAgents && <span data-kind="agent">{t("wiki.legend.agents")}</span>}
          {hasObsidian && <span data-kind="obsidian">{t("wiki.legend.obsidian")}</span>}
        </p>
      </div>
    </section>
  );
}
