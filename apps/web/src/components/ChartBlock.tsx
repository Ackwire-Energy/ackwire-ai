import { type ChartSpec, chartShares, chartTable, formatChartValue, parseChart } from "@agenteschat/client/lib/chart";
import { type AgentColor, Button, Dialog, DialogBody, PixelSpinner, parseColor } from "@agenteschat/ui";
import {
  areaCells,
  barCells,
  CHART_CELL,
  chartAreaTones,
  chartInk,
  chartRamp,
  chartSlices,
  linePoints,
  lineTops,
  ringCells,
  smoothPath,
} from "@agenteschat/ui/sky/chart";
import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { CodeBlock } from "@/components/CodeBlock";
import { useDarkTheme, useGrowFrom } from "@/lib/grow";

/** The color of the agent who wrote the message (its charts take its tones); sky elsewhere. */
export const ChartAccent = createContext<AgentColor>("sky");

/**
 * Charts already drawn once (by their data): when an answer stops streaming, the live row gives way to the
 * message and the chart mounts again; it shouldn't grow in twice.
 */
const drawn = new Set<string>();
const ChartStill = createContext(false);

const reduceMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A ```chart block: the chart when its JSON reads as one, else the code (while an answer is still being
 * written, a "montando o gráfico" card instead of half a JSON).
 */
export function ChartOrCode({ text, writing }: { text: string; writing?: boolean }) {
  const spec = useMemo(() => parseChart(text), [text]);
  if (spec) return <ChartBlock spec={spec} />;
  if (writing) return <ChartPending />;
  return <CodeBlock lang="json" text={text} />;
}

function ChartPending() {
  const { t } = useTranslation();
  return (
    <div className="chart-card chart-card--pending" role="status">
      <PixelSpinner size={16} />
      <span>{t("common.chartPending")}</span>
    </div>
  );
}

/**
 * A chart in a message (telas/GraficosChat.html, C · Traço + trama): clean shapes filled with a fine dither
 * in the agent's tones. Hover shows a value; "Tabela" flips the card to the same data as a table; full screen
 * grows out of the card with the chart big and its table under it.
 */
export function ChartBlock({ spec }: { spec: ChartSpec }) {
  const { t } = useTranslation();
  const [table, setTable] = useState(false);
  const [still] = useState(() => {
    const key = JSON.stringify([spec.type, spec.title, spec.labels, spec.series, spec.value]);
    const seen = drawn.has(key);
    drawn.add(key);
    return seen;
  });
  const [open, setOpen] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const remember = useGrowFrom(open, card, ".chart-viewer");
  return (
    <figure className="chart-card" ref={card}>
      <figcaption className="chart-card__top">
        <span className="chart-card__titles">
          <b>{spec.title}</b>
          {spec.subtitle && <small>{spec.subtitle}</small>}
        </span>
        <Button variant="ghost" size="sm" aria-pressed={table} onClick={() => setTable((v) => !v)}>
          {t("common.table")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="expand"
          aria-label={t("common.fullScreen")}
          title={t("common.fullScreen")}
          onClick={() => {
            remember();
            setOpen(true);
          }}
        />
      </figcaption>
      <div className="chart-card__body">
        <ChartStill.Provider value={still}>
          {table ? <ChartTable spec={spec} /> : <ChartView spec={spec} />}
        </ChartStill.Provider>
      </div>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={spec.title}
        description={spec.subtitle}
        closeLabel={t("common.close")}
        width={880}
        className="chart-viewer"
      >
        <DialogBody className="chart-viewer__body">
          <ChartView spec={spec} big />
          <ChartTable spec={spec} />
        </DialogBody>
      </Dialog>
    </figure>
  );
}

function ChartView({ spec, big = false }: { spec: ChartSpec; big?: boolean }) {
  switch (spec.type) {
    case "bar":
      return <BarChart spec={spec} big={big} />;
    case "line":
      return <LineChart spec={spec} big={big} />;
    case "pie":
      return <PieChart spec={spec} big={big} />;
    default:
      return <NumberChart spec={spec} big={big} />;
  }
}

function ChartTable({ spec }: { spec: ChartSpec }) {
  const { t, i18n } = useTranslation();
  const { header, rows } = chartTable(spec, i18n.language, {
    item: t("common.chartItem"),
    share: t("common.chartShare"),
  });
  return (
    <div className="md__table chart-table">
      <table>
        <thead>
          <tr>
            {header.map((h, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static table
              <th key={j} style={{ textAlign: j ? "right" : "left" }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static table
            <tr key={i}>
              {r.map((c, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static table
                <td key={j} style={{ textAlign: j ? "right" : "left" }}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- pieces ---------- */

/** True a frame after mount (so a width or a stroke can transition from zero); at once with reduced motion. */
function useShown() {
  const still = useContext(ChartStill);
  const [shown, setShown] = useState(() => still || reduceMotion());
  useEffect(() => {
    if (shown) return;
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, [shown]);
  return shown;
}

/** An element's width, kept up to date. */
function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Paints cells (one canvas pixel each, drawn at CHART_CELL points) in the color `tone(value)` gives. */
function paintCells(
  canvas: HTMLCanvasElement | null,
  cols: number,
  rows: number,
  cells: ArrayLike<number>,
  tone: (value: number) => string | null,
) {
  if (!canvas || cols < 1 || rows < 1) return;
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const img = ctx.createImageData(cols, rows);
  const cache = new Map<number, [number, number, number] | null>();
  for (let i = 0; i < cols * rows; i++) {
    const v = cells[i] ?? -1;
    if (!cache.has(v)) {
      const c = tone(v);
      cache.set(v, c ? parseColor(c) : null);
    }
    const rgb = cache.get(v);
    if (!rgb) continue;
    img.data[i * 4] = rgb[0];
    img.data[i * 4 + 1] = rgb[1];
    img.data[i * 4 + 2] = rgb[2];
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

type Tip = { x: number; y: number; text: ReactNode } | null;

function TipLayer({ tip }: { tip: Tip }) {
  return (
    <span
      className="chart-tip"
      data-on={Boolean(tip)}
      data-below={tip ? tip.y < 44 : undefined}
      style={tip ? { left: tip.x, top: tip.y } : undefined}
      aria-hidden="true"
    >
      {tip?.text}
    </span>
  );
}

/* ---------- bars ---------- */

function BarChart({ spec, big }: { spec: ChartSpec; big: boolean }) {
  const { i18n } = useTranslation();
  const color = useContext(ChartAccent);
  const values = spec.series[0]?.values ?? [];
  const max = Math.max(0, ...values) || 1;
  const shown = useShown();
  const [rail, railWidth] = useWidth<HTMLSpanElement>();
  const [tip, setTip] = useState<Tip>(null);
  const [hot, setHot] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const height = big ? 20 : 14;
  return (
    <div
      className="chart-bars"
      data-big={big}
      ref={box}
      onPointerLeave={() => {
        setTip(null);
        setHot(null);
      }}
    >
      {spec.labels.map((label, i) => {
        const value = values[i] ?? 0;
        const share = Math.max(0, value) / max;
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: the rows of one chart, in order
            key={i}
            className="chart-bar"
            data-dim={hot !== null && hot !== i}
            onPointerEnter={(e) => {
              const b = box.current?.getBoundingClientRect();
              const r = (
                e.currentTarget.querySelector(".chart-bar__rail") as HTMLElement | null
              )?.getBoundingClientRect();
              setHot(i);
              if (b && r)
                setTip({
                  x: r.left - b.left + r.width * share,
                  y: r.top - b.top,
                  text: `${label}: ${formatChartValue(value, spec.unit, i18n.language)}`,
                });
            }}
          >
            <span className="chart-bar__label">{label}</span>
            <span className="chart-bar__rail" ref={i === 0 ? rail : undefined} style={{ height }}>
              <span className="chart-bar__fill" style={{ width: shown ? `${share * 100}%` : 0 }}>
                <BarFill width={railWidth * share} height={height} color={color} lead={value === max} />
              </span>
            </span>
            <span className="chart-bar__value">{formatChartValue(value, spec.unit, i18n.language)}</span>
          </div>
        );
      })}
      <TipLayer tip={tip} />
    </div>
  );
}

function BarFill({ width, height, color, lead }: { width: number; height: number; color: AgentColor; lead: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const cols = Math.max(1, Math.round(width / CHART_CELL));
  const rows = Math.max(1, Math.round(height / CHART_CELL));
  useEffect(() => {
    const ramp = chartRamp(color);
    paintCells(canvas.current, cols, rows, barCells(cols, rows, lead), (v) => ramp[v] ?? null);
  }, [cols, rows, color, lead]);
  return <canvas ref={canvas} className="chart-cells" style={{ width, height }} />;
}

/* ---------- line ---------- */

function LineChart({
  spec,
  big,
  spark = false,
  height,
}: {
  spec: ChartSpec;
  big: boolean;
  spark?: boolean;
  height?: number;
}) {
  const { i18n } = useTranslation();
  const color = useContext(ChartAccent);
  const dark = useDarkTheme();
  const shown = useShown();
  const [plot, width] = useWidth<HTMLDivElement>();
  const h = height ?? (big ? 260 : 150);
  const main = spec.series[0]?.values ?? [];
  const all = useMemo(() => spec.series.flatMap((s) => s.values), [spec.series]);
  const points = useMemo(() => {
    if (width < 10 || all.length === 0) return [];
    // One scale for every series: map all values, then split back per series.
    const flat = linePoints(all, width, h);
    return spec.series.map((s, k) => {
      const offset = spec.series.slice(0, k).reduce((n, x) => n + x.values.length, 0);
      return s.values.map((_, i): [number, number] => {
        const [, y] = flat[offset + i] ?? [0, 0];
        const x = 8 + (i * (width - 16)) / Math.max(1, s.values.length - 1);
        return [x, y];
      });
    });
  }, [width, h, spec.series, all]);
  const ink = chartInk(color, dark);
  const slices = chartSlices(color, dark);
  const path = useRef<SVGPathElement>(null);
  const area = useRef<HTMLCanvasElement>(null);
  const [length, setLength] = useState(0);
  const [tip, setTip] = useState<Tip>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const first = points[0] ?? [];
  const at = cursor === null ? undefined : first[cursor];
  const peak = main.indexOf(Math.max(...main));

  // The area under the main line: a fine dither following the same curve; the stroke draws itself in.
  useLayoutEffect(() => {
    const el = path.current;
    if (!el || width < 10) return;
    setLength(el.getTotalLength());
    const cols = Math.round(width / CHART_CELL);
    const rows = Math.round(h / CHART_CELL);
    const tops = lineTops(first, cols);
    const [near, far] = chartAreaTones(color, dark);
    paintCells(area.current, cols, rows, areaCells(cols, rows, tops), (v) => (v === 1 ? near : v === 2 ? far : null));
  }, [width, h, color, dark, first]);

  return (
    <div className="chart-line" data-spark={spark}>
      <div
        className="chart-line__plot"
        ref={plot}
        style={{ height: h }}
        onPointerMove={
          spark
            ? undefined
            : (e) => {
                const r = e.currentTarget.getBoundingClientRect();
                const x = e.clientX - r.left;
                let i = 0;
                first.forEach((p, j) => {
                  if (Math.abs(p[0] - x) < Math.abs((first[i]?.[0] ?? 0) - x)) i = j;
                });
                const p = first[i];
                if (!p) return;
                setCursor(i);
                setTip({
                  x: p[0],
                  y: p[1],
                  text: `${spec.labels[i]}: ${spec.series
                    .map((s) => formatChartValue(s.values[i] ?? 0, spec.unit, i18n.language))
                    .join(" · ")}`,
                });
              }
        }
        onPointerLeave={() => {
          setTip(null);
          setCursor(null);
        }}
      >
        <canvas ref={area} className="chart-cells chart-line__area" data-shown={shown} />
        {width > 10 && (
          <svg viewBox={`0 0 ${width} ${h}`} width={width} height={h} aria-hidden="true">
            {!spark &&
              [0.25, 0.5, 0.75].map((k) => (
                <line key={k} x1={0} x2={width} y1={h * k} y2={h * k} className="chart-line__grid" />
              ))}
            {at && <line x1={at[0]} x2={at[0]} y1={0} y2={h} className="chart-line__cursor" />}
            {points.slice(1).map((pts, k) => (
              <path
                // biome-ignore lint/suspicious/noArrayIndexKey: the series, in order
                key={k}
                d={smoothPath(pts)}
                fill="none"
                stroke={slices[k * 2 + 2] ?? ink}
                strokeWidth={1.8}
                strokeDasharray="4 4"
              />
            ))}
            <path
              ref={path}
              d={smoothPath(first)}
              fill="none"
              stroke={ink}
              strokeWidth={big ? 3 : 2.4}
              strokeLinecap="round"
              className="chart-line__stroke"
              style={length ? { strokeDasharray: length, strokeDashoffset: shown ? 0 : length } : undefined}
            />
            {!spark &&
              first.map(([x, y], i) => (
                <circle
                  // biome-ignore lint/suspicious/noArrayIndexKey: the points, in order
                  key={i}
                  cx={x}
                  cy={y}
                  r={i === peak ? 4.5 : 3}
                  fill={i === peak ? ink : "var(--surface-sunken)"}
                  stroke={ink}
                  strokeWidth={2}
                  className="chart-line__point"
                  data-shown={shown}
                />
              ))}
          </svg>
        )}
        <TipLayer tip={tip} />
      </div>
      {!spark && (
        <div className="chart-line__x">
          {spec.labels.map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the labels, in order
            <span key={i}>{l}</span>
          ))}
        </div>
      )}
      {!spark && spec.series.length > 1 && (
        <div className="chart-legend">
          {spec.series.map((s, k) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the series, in order
            <span key={k}>
              <i style={{ background: k === 0 ? ink : slices[k * 2] }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- pie ---------- */

function PieChart({ spec, big }: { spec: ChartSpec; big: boolean }) {
  const { i18n } = useTranslation();
  const color = useContext(ChartAccent);
  const dark = useDarkTheme();
  const size = big ? 220 : 132;
  const shares = useMemo(() => chartShares(spec), [spec]);
  const slices = useMemo(() => chartSlices(color, dark), [color, dark]);
  const values = spec.series[0]?.values ?? [];
  const total = values.reduce((a, b) => a + b, 0);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [tip, setTip] = useState<Tip>(null);
  const still = useContext(ChartStill);

  // The ring sweeps in clockwise once; then it stays drawn.
  useEffect(() => {
    const cells = Math.round(size / CHART_CELL);
    const draw = (sweep: number) =>
      paintCells(canvas.current, cells, cells, ringCells(cells, shares, sweep), (v) =>
        v < 0 ? null : (slices[v % slices.length] ?? null),
      );
    if (still || reduceMotion()) return draw(1);
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / 700);
      draw(1 - (1 - p) ** 3);
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [size, shares, slices, still]);

  return (
    <div className="chart-pie">
      <div className="chart-pie__ring" style={{ width: size, height: size }}>
        <canvas ref={canvas} className="chart-cells" />
        <span className="chart-pie__total">
          {formatChartValue(total, spec.unit, i18n.language)}
          <small>{spec.series[0]?.name}</small>
        </span>
      </div>
      <ul className="chart-pie__legend" onPointerLeave={() => setTip(null)}>
        {spec.labels.map((label, i) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: the slices, in order
            key={i}
            onPointerEnter={() =>
              setTip({
                x: size / 2,
                y: 4,
                text: `${label}: ${formatChartValue(values[i] ?? 0, spec.unit, i18n.language)}`,
              })
            }
          >
            <i style={{ background: slices[i % slices.length] }} />
            <span>{label}</span>
            <b>{formatChartValue(Math.round((shares[i] ?? 0) * 100), "%", i18n.language)}</b>
          </li>
        ))}
      </ul>
      <TipLayer tip={tip} />
    </div>
  );
}

/* ---------- number ---------- */

function NumberChart({ spec, big }: { spec: ChartSpec; big: boolean }) {
  const { i18n } = useTranslation();
  const hasLine = spec.labels.length > 1 && (spec.series[0]?.values.length ?? 0) > 1;
  return (
    <div className="chart-number" data-big={big}>
      <div>
        <div className="chart-number__value">{formatChartValue(spec.value ?? 0, spec.unit, i18n.language)}</div>
        {spec.delta && <div className="chart-number__delta">{spec.delta}</div>}
      </div>
      {hasLine && (
        <div className="chart-number__spark">
          <LineChart spec={spec} big={big} spark height={big ? 110 : 56} />
        </div>
      )}
    </div>
  );
}
