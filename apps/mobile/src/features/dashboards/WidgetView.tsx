import type {
  BarsWidgetSpec,
  GoalWidgetSpec,
  KpiWidgetSpec,
  LineWidgetSpec,
  ListWidgetSpec,
  TextWidgetSpec,
  WidgetKind,
  WidgetSchedule,
  WidgetSpec,
  WidgetStatus,
} from "@agenteschat/client";
import type { ChartSpec } from "@agenteschat/client/lib/chart";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { Canvas } from "@shopify/react-native-skia";
import { memo, type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type LayoutChangeEvent, StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { CHROME_MAX_SCALE, Icon, PixelOrbit, PressScale, Text, useReducedMotion, useTheme } from "@/ui";
import { Line } from "../chat/ChartCard";
import { AgentFace } from "../shared/Face";
import { useSurface } from "../shared/parts";
import { DitherShape } from "./Dither";
import { useAgentLook, useWidgetWords } from "./hooks";
import {
  barWords,
  formatWidgetNumber,
  formatWithUnit,
  goalShare,
  isTall,
  roundRectPath,
  shownWidgetTitle,
  topRoundedPath,
  widgetTones,
} from "./logic";

/**
 * The phone's widget (ADR 0134): a block an agent keeps up to date, drawn from its spec like the web's. Numbers in
 * the app's sans at weight 700 with tabular figures; charts as the chat draws them (a clean stroke in the agent's
 * deep tone over a dither in its light one: the line is the chat's own); bars and a goal's fill as outlined shapes
 * filled with the same 2-point Bayer dither. While the agent builds it, a dither sweep; while it updates, the last
 * data stays, dimmed; when it failed, dimmed with the reason under it.
 */

function useWidth(): [number, (e: LayoutChangeEvent) => void] {
  const [width, setWidth] = useState(0);
  return [width, (e) => setWidth(Math.round(e.nativeEvent.layout.width))];
}

/** A series as the chat's chart spec, for its line. */
const lineSpec = (labels: string[], values: number[], unit?: string): ChartSpec => ({
  type: "line",
  title: "",
  labels,
  series: [{ name: "", values }],
  ...(unit ? { unit } : {}),
});

/** What a widget shows: its data by kind, the building sweep, or a quiet line when it has nothing yet. */
export const WidgetBody = memo(function WidgetBody({
  spec,
  status,
  agentId,
  big = false,
}: {
  spec: WidgetSpec | null;
  status: WidgetStatus;
  agentId: string;
  /** The widget's own screen and the previews: bigger numbers and charts. */
  big?: boolean;
}) {
  const { t } = useTranslation();
  const look = useAgentLook(agentId);
  if (!spec) {
    if (status === "failed")
      return (
        <Text variant="footnote" tone="faint">
          {t("widgets.status.failed")}
        </Text>
      );
    return <BuildingSweep color={look.color} text={t("widgets.status.building", { name: look.name })} />;
  }
  if (status === "building") {
    return <BuildingSweep color={look.color} text={t("widgets.status.building", { name: look.name })} />;
  }
  const dim = status === "updating" ? 0.45 : status === "failed" ? 0.5 : 1;
  return (
    <View style={{ opacity: dim }}>
      <SpecBody spec={spec} color={look.color} big={big} />
    </View>
  );
});

function SpecBody({ spec, color, big }: { spec: WidgetSpec; color: AgentColorName; big: boolean }) {
  switch (spec.kind) {
    case "kpi":
      return <Kpi spec={spec} color={color} big={big} />;
    case "goal":
      return <Goal spec={spec} color={color} big={big} />;
    case "bars":
      return <Bars spec={spec} color={color} big={big} />;
    case "line":
      return <LineBody spec={spec} color={color} big={big} />;
    case "list":
      return <List spec={spec} />;
    case "text":
      return <Summary spec={spec} color={color} />;
  }
}

/** The big number: what comes before and after it smaller, how it moved, its trend. */
function Kpi({ spec, color, big }: { spec: KpiWidgetSpec; color: AgentColorName; big: boolean }) {
  const { i18n } = useTranslation();
  const { colors: c } = useTheme();
  const spark = spec.spark ?? [];
  const trend = useMemo(() => (spark.length > 1 ? lineSpec(spark.map((_, i) => String(i)), spark) : null), [spark]);
  return (
    <View>
      <Text variant="display" numberOfLines={1} style={[styles.num, big ? styles.numBig : null, { color: c.ink }]}>
        {spec.prefix ? <Text style={[styles.affix, { color: c.muted }]}>{`${spec.prefix} `}</Text> : null}
        {formatWidgetNumber(spec.value, i18n.language)}
        {spec.suffix ? <Text style={[styles.affix, { color: c.muted }]}>{` ${spec.suffix}`}</Text> : null}
      </Text>
      {spec.delta || spec.note ? (
        <Text variant="footnote" tone="ink2" numberOfLines={2}>
          {spec.delta ? (
            <Text variant="footnote" style={[styles.strong, { color: spec.delta.up ? c.ok : c.warn }]}>
              {spec.delta.text}
            </Text>
          ) : null}
          {spec.delta && spec.note ? " " : null}
          {spec.note ?? null}
        </Text>
      ) : null}
      {trend ? (
        <View style={styles.spark}>
          <Line spec={trend} accent={color} big={false} spark height={big ? 60 : 30} />
        </View>
      ) : null}
    </View>
  );
}

/** Progress towards a goal: the share, a track filled with the dither, the line and the note. */
function Goal({ spec, color, big }: { spec: GoalWidgetSpec; color: AgentColorName; big: boolean }) {
  const { colors: c, scheme } = useTheme();
  const tones = widgetTones(color, scheme === "dark");
  const [width, onLayout] = useWidth();
  const height = big ? 16 : 12;
  // Inside the track's 1.5-point border.
  const inner = height - 3;
  const fill = Math.round(Math.max(0, width - 3) * goalShare(spec.pct));
  return (
    <View>
      <Text variant="display" numberOfLines={1} style={[styles.num, big ? styles.numBig : null, { color: c.ink }]}>
        {Math.round(spec.pct)}
        <Text style={[styles.affix, { color: c.muted }]}>%</Text>
      </Text>
      <View onLayout={onLayout} style={[styles.track, { height, borderColor: c.line2 }]}>
        {fill > 3 ? (
          <Canvas style={{ width: fill, height: inner }}>
            <DitherShape
              width={fill}
              height={inner}
              shape={roundRectPath(0.75, 0.75, fill - 1.5, inner - 1.5, 3)}
              fill={tones.fill}
              stroke={tones.stroke}
            />
          </Canvas>
        ) : null}
      </View>
      <Text variant="footnote" tone="ink2" numberOfLines={big ? 3 : 2}>
        {spec.line}
        {spec.note ? (
          <Text variant="footnote" tone="faint">
            {` · ${spec.note}`}
          </Text>
        ) : null}
      </Text>
    </View>
  );
}

/** Columns with their value over them and their label under; the one an alert is about in the warning color. */
function Bars({ spec, color, big }: { spec: BarsWidgetSpec; color: AgentColorName; big: boolean }) {
  const { i18n } = useTranslation();
  const { colors: c, scheme } = useTheme();
  const tones = widgetTones(color, scheme === "dark");
  const [width, onLayout] = useWidth();
  const n = spec.values.length;
  const gap = n > 12 ? 3 : 8;
  const slot = n > 0 ? Math.max(0, (width - gap * (n - 1)) / n) : 0;
  const bw = Math.min(44, slot);
  const words = barWords(n, width);
  const height = big ? 140 : 84;
  const room = height - 18;
  const max = Math.max(0, ...spec.values) || 1;
  return (
    <View>
      <View onLayout={onLayout} style={[styles.bars, { height, gap }]}>
        {width > 0
          ? spec.values.map((v, i) => {
              const h = Math.max(4, Math.round((Math.max(0, v) / max) * room));
              const alert = spec.alertIndex === i;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: the bars of one widget, in order
                <View key={i} style={styles.bar} accessible accessibilityLabel={`${spec.labels[i] ?? ""}: ${v}`}>
                  {words.values ? (
                    <Text
                      variant="caption"
                      numberOfLines={1}
                      maxFontSizeMultiplier={CHROME_MAX_SCALE}
                      style={[styles.barValue, { color: alert ? c.warn : c.ink2 }]}
                    >
                      {formatWithUnit(v, undefined, i18n.language)}
                    </Text>
                  ) : null}
                  {bw > 1 ? (
                    <Canvas style={{ width: bw, height: h }}>
                      <DitherShape
                        width={bw}
                        height={h}
                        shape={topRoundedPath(0.75, 0.75, bw - 1.5, h - 0.75, 4)}
                        outline={topRoundedPath(0.75, 0.75, bw - 1.5, h - 0.75, 4, false)}
                        fill={tones.fill}
                        stroke={alert ? c.warn : tones.stroke}
                      />
                    </Canvas>
                  ) : null}
                </View>
              );
            })
          : null}
      </View>
      <View style={[styles.axis, { gap, borderTopColor: c.line2 }]}>
        {spec.labels.map((label, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the labels, in order
          <Text key={i} variant="caption" tone="faint" numberOfLines={1} style={styles.axisLabel}>
            {i % words.every === 0 || i === n - 1 ? label : ""}
          </Text>
        ))}
      </View>
      {spec.note ? (
        <Text variant="footnote" tone="ink2" numberOfLines={2} style={styles.note}>
          {spec.note}
        </Text>
      ) : null}
    </View>
  );
}

/** The chat's line: bare on a card, with its points and labels (tap one for its value) on the widget's screen. */
function LineBody({ spec, color, big }: { spec: LineWidgetSpec; color: AgentColorName; big: boolean }) {
  const chart = useMemo(() => lineSpec(spec.labels, spec.values, spec.unit), [spec.labels, spec.values, spec.unit]);
  return (
    <View>
      <Line spec={chart} accent={color} big={big} spark={!big} height={big ? 160 : 80} />
      {spec.note ? (
        <Text variant="footnote" tone="ink2" numberOfLines={2} style={styles.note}>
          {spec.note}
        </Text>
      ) : null}
    </View>
  );
}

/** A few rows with a word each, in the warning or the good color when the agent says so. */
function List({ spec }: { spec: ListWidgetSpec }) {
  const { colors: c } = useTheme();
  return (
    <View>
      {spec.rows.map((row, i) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: the rows of one widget, in order
          key={i}
          style={[styles.row, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line2 } : null]}
        >
          <Text variant="subhead" tone="ink" numberOfLines={1} style={styles.grow}>
            {row.text}
          </Text>
          {row.meta ? (
            <Text
              variant="footnote"
              numberOfLines={1}
              style={[
                styles.meta,
                row.tone ? styles.strong : null,
                { color: row.tone === "warn" ? c.warn : row.tone === "ok" ? c.ok : c.faint },
              ]}
            >
              {row.meta}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

/** A few sentences, each after a small mark in the agent's tone. */
function Summary({ spec, color }: { spec: TextWidgetSpec; color: AgentColorName }) {
  const { scheme } = useTheme();
  const tones = widgetTones(color, scheme === "dark");
  return (
    <View style={styles.items}>
      {spec.items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the sentences of one widget, in order
        <View key={i} style={styles.item}>
          <View style={[styles.mark, { backgroundColor: tones.stroke }]} />
          <Text variant="subhead" tone="ink" style={styles.grow}>
            {item}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The first build: a field of the agent's dither with a denser band sweeping across it (still with reduced
 * motion), and what is happening under it.
 */
export function BuildingSweep({ color, text, height = 56 }: { color: AgentColorName; text: string; height?: number }) {
  const { scheme } = useTheme();
  const reduced = useReducedMotion();
  const tones = widgetTones(color, scheme === "dark");
  const [width, onLayout] = useWidth();
  const band = Math.max(24, Math.round(width * 0.4));
  const at = useSharedValue(0);
  useEffect(() => {
    if (reduced || width === 0) return;
    at.value = 0;
    at.value = withRepeat(withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.quad) }), -1, false);
    return () => cancelAnimation(at);
  }, [reduced, width, at]);
  const sweep = useAnimatedStyle(() => ({ transform: [{ translateX: -band + at.value * (width + band) }] }));
  const box = roundRectPath(0, 0, width, height, 6);
  return (
    <View style={styles.building} accessibilityRole="progressbar" accessibilityLabel={text}>
      <View onLayout={onLayout} style={[styles.field, { height }]}>
        {width > 0 ? (
          <>
            <Canvas style={StyleSheet.absoluteFill}>
              <DitherShape width={width} height={height} shape={box} fill={tones.fill} density={0.16} />
            </Canvas>
            <Animated.View
              style={[styles.band, { width: band, left: reduced ? (width - band) / 2 : 0 }, reduced ? null : sweep]}
            >
              <Canvas style={StyleSheet.absoluteFill}>
                <DitherShape
                  width={band}
                  height={height}
                  shape={roundRectPath(0, 0, band, height, 0)}
                  fill={tones.fill}
                  density={0.6}
                />
              </Canvas>
            </Animated.View>
          </>
        ) : null}
      </View>
      <Text variant="footnote" tone="muted" numberOfLines={3}>
        {text}
      </Text>
    </View>
  );
}

export interface WidgetCardData {
  /** Empty while the agent hasn't named it yet: the card says the kind's word or "New widget". */
  title: string;
  /** What it shows, when known (the word a widget without a title shows). */
  kind?: WidgetKind | null;
  spec: WidgetSpec | null;
  status: WidgetStatus;
  agentId: string;
  refreshedAt: string | null;
  schedule: WidgetSchedule;
  /** Its width on the board: 2 takes the whole row on the phone. */
  w: 1 | 2;
  /** Its height on the board: 2 (L) stands taller on the phone. */
  h?: 1 | 2;
}

/**
 * A widget on a board: its title, what it shows, and a footer that says who looks after it and when it last
 * updated ("updating…" while it does, the failure and Resolve when it didn't). The card has the design system's cut
 * corner and is neutral (the agent's tones are only in the data). `footer` replaces the footer (a preview's).
 */
export function WidgetCard({
  widget: w,
  big = false,
  footer,
  onPress,
  label,
}: {
  widget: WidgetCardData;
  big?: boolean;
  footer?: ReactNode;
  onPress?: () => void;
  /** What a screen reader says for the whole card when it opens. */
  label?: string;
}) {
  const { t } = useTranslation();
  const surface = useSurface();
  // A 2-high (L) widget on a board draws its data big, as on its own screen.
  const large = big || isTall(w.h ?? 1);
  const title = shownWidgetTitle(w.title, w.kind, (key) => t(key));
  const content = (
    <>
      <Text variant="footnote" tone="muted" numberOfLines={large ? 2 : 1} style={styles.title}>
        {title}
      </Text>
      <View style={styles.body}>
        <WidgetBody spec={w.spec} status={w.status} agentId={w.agentId} big={large} />
      </View>
      {footer === undefined ? <WidgetFoot widget={w} /> : footer}
    </>
  );
  if (!onPress) return <View style={[styles.card, surface]}>{content}</View>;
  return (
    <PressScale
      to={0.98}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label ?? title}
      style={[styles.card, surface]}
      contentStyle={styles.cardIn}
      fill={false}
    >
      {content}
    </PressScale>
  );
}

/** "Theo · 12 min ago" (and how often, when there's room), "Theo updating…", or "Didn't update · Resolve". */
function WidgetFoot({ widget: w }: { widget: WidgetCardData }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const look = useAgentLook(w.agentId);
  const words = useWidgetWords();
  if (w.status === "building") return null;
  if (w.status === "updating")
    return (
      <View style={styles.foot}>
        <PixelOrbit color={look.color} size={12} />
        <Text variant="caption" tone="faint" numberOfLines={1} style={styles.grow}>
          {t("widgets.status.updating", { name: look.name })}
        </Text>
      </View>
    );
  if (w.status === "failed")
    return (
      <View style={styles.foot}>
        <Icon name="info" size={13} color={c.warn} />
        <Text variant="caption" numberOfLines={1} style={[styles.grow, { color: c.warn }]}>
          {`${t("widgets.status.failed")} · ${t("widgets.failure.resolve")}`}
        </Text>
      </View>
    );
  const when = w.refreshedAt ? words.ago(w.refreshedAt) : "";
  const line =
    w.w === 2 && when
      ? t("widgets.foot", { name: look.name, when, schedule: t(`widgets.schedulesInline.${w.schedule}`) })
      : [look.name, when].filter(Boolean).join(" · ");
  return (
    <View style={styles.foot}>
      <AgentFace agentId={w.agentId} size={16} live={false} />
      <Text variant="caption" tone="faint" numberOfLines={1} style={styles.grow}>
        {line}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderBottomRightRadius: 20,
    borderBottomLeftRadius: 6,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
    gap: 6,
    minWidth: 0,
    // Two widgets side by side stand as tall as each other.
    flexGrow: 1,
  },
  cardIn: { gap: 6 },
  title: { fontWeight: "600" },
  body: { flexGrow: 1, minWidth: 0 },
  num: { fontSize: 30, lineHeight: 34, fontWeight: "700", letterSpacing: -0.9, fontVariant: ["tabular-nums"] },
  numBig: { fontSize: 40, lineHeight: 44, letterSpacing: -1.2 },
  affix: { fontSize: 15, fontWeight: "600", letterSpacing: 0 },
  strong: { fontWeight: "600" },
  spark: { marginTop: 6 },
  track: {
    borderRadius: 4,
    borderWidth: 1.5,
    overflow: "hidden",
    marginTop: 8,
    marginBottom: 6,
    justifyContent: "center",
  },
  bars: { flexDirection: "row", alignItems: "flex-end", paddingTop: 14 },
  bar: { flex: 1, minWidth: 0, alignItems: "center", justifyContent: "flex-end", height: "100%" },
  barValue: { fontWeight: "600", fontVariant: ["tabular-nums"], marginBottom: 2 },
  axis: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 4 },
  axisLabel: { flex: 1, minWidth: 0, textAlign: "center" },
  note: { marginTop: 4 },
  row: { flexDirection: "row", alignItems: "baseline", gap: 8, paddingVertical: 6 },
  meta: { flexShrink: 0, maxWidth: "45%" },
  grow: { flex: 1, minWidth: 0 },
  items: { gap: 4 },
  item: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  mark: { width: 5, height: 5, borderRadius: 1.5, marginTop: 8 },
  building: { gap: 8 },
  field: { borderRadius: 6, overflow: "hidden" },
  band: { position: "absolute", top: 0, bottom: 0 },
  foot: { flexDirection: "row", alignItems: "center", gap: 6 },
});
