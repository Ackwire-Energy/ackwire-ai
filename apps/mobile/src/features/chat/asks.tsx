import {
  type BrowserHandoff,
  browserHandoffOf,
  handoffScreen,
  type Message,
  type SecretRequest,
  useApproval,
  useBrowserHandoff,
} from "@agenteschat/client";
import { agentProposalOf, proposalStatus } from "@agenteschat/client/lib/action-cards";
import { timeLeft } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text as RNText, StyleSheet, View } from "react-native";
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import { Sky } from "@/sky/Sky";
import { CHROME_MAX_SCALE, Fuse, Icon, Text, useReducedMotion, useTheme } from "@/ui";
import { approvalTitleText } from "../approvals/parts";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useMeId, useNow, useOrgId } from "../shared/hooks";
import { agentLook, fuseRemaining } from "../shared/logic";
import { tapHaptic } from "../shared/parts";
import { approvalIdOf, markedParts, markName, questionOf } from "./logic";

/**
 * A request in the conversation (an approval, a secret, a question, help in the agent's browser or on its
 * computer, a proposal) is one card for all: what it asks in a small label with its state, the agent's own
 * words, the thing it is about in a well (whole under "Ver …"), then a strip with when it expires and the
 * decision. While one waits out of view, the line above the composer says so and takes the person to it.
 */

export type AskKind = "approval" | "secret" | "question" | "browser" | "desktop" | "proposal";

// ── Which requests wait here ─────────────────────────────────────────────────

/** A request the person can answer now, in this conversation. `order`: where its message sits in the list. */
export interface PendingAsk {
  id: string;
  kind: AskKind;
  agentId: string;
  /** The thing it is about, short (the action, the secret's name, the question). */
  what: string;
  messageId: string;
  order: number;
}

/** The first request out of view and how many more are. */
export interface AwayAsk {
  ask: PendingAsk;
  more: number;
}

/**
 * The requests waiting here and which messages the list shows. Kept outside React so the list's
 * visibility (it changes on every scroll) only redraws what reads it, and only when the answer changes.
 */
export class AskStore {
  private asks = new Map<string, PendingAsk>();
  private settled = new Set<string>();
  private visible = new Set<string>();
  /** The list said what it shows at least once: before that every request would look out of view. */
  private measured = false;
  private listeners = new Set<() => void>();
  private away: AwayAsk | null = null;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getAway = () => this.away;

  put(ask: PendingAsk) {
    if (this.settled.has(ask.id)) return;
    const old = this.asks.get(ask.id);
    if (
      old &&
      old.kind === ask.kind &&
      old.what === ask.what &&
      old.messageId === ask.messageId &&
      old.order === ask.order &&
      old.agentId === ask.agentId
    )
      return;
    this.asks.set(ask.id, ask);
    this.update();
  }

  drop(id: string) {
    if (this.asks.delete(id)) this.update();
  }

  /** Answered here: gone at once, before the server's own update arrives. */
  settle(id: string) {
    this.settled.add(id);
    this.drop(id);
  }

  setVisible(messageIds: string[]) {
    const next = new Set(messageIds);
    if (this.measured && next.size === this.visible.size && [...next].every((id) => this.visible.has(id))) return;
    this.visible = next;
    this.measured = true;
    this.update();
  }

  private update() {
    const out = this.measured
      ? [...this.asks.values()].filter((a) => !this.visible.has(a.messageId)).sort((a, b) => a.order - b.order)
      : [];
    const first = out[0];
    const next = first ? { ask: first, more: out.length - 1 } : null;
    const prev = this.away;
    const same =
      prev === next ||
      (prev &&
        next &&
        prev.ask.id === next.ask.id &&
        prev.ask.what === next.ask.what &&
        prev.ask.kind === next.ask.kind &&
        prev.more === next.more);
    if (same) return;
    this.away = next;
    for (const listener of this.listeners) listener();
  }
}

const AskStoreContext = createContext<AskStore | null>(null);

export function AskStoreProvider({ store, children }: { store: AskStore; children: ReactNode }) {
  return <AskStoreContext.Provider value={store}>{children}</AskStoreContext.Provider>;
}

/** The conversation's requests (null outside a conversation: a card elsewhere reports nothing). */
export const useAskStore = () => useContext(AskStoreContext);

/** The first request waiting out of view, redrawn only when that changes. */
export function useAwayAsk(store: AskStore): AwayAsk | null {
  return useSyncExternalStore(store.subscribe, store.getAway, store.getAway);
}

/** `meta.secretRequest`, when it is one. */
export function secretRequestOf(meta: Message["meta"]): SecretRequest | null {
  const s = meta?.secretRequest as Partial<SecretRequest> | undefined;
  return s && typeof s === "object" && typeof s.id === "string" && typeof s.status === "string" && s.target
    ? (s as SecretRequest)
    : null;
}

const asksSomething = (m: Message) =>
  m.author.type === "agent" &&
  Boolean(
    approvalIdOf(m.meta) ||
      questionOf(m.meta) ||
      secretRequestOf(m.meta) ||
      browserHandoffOf(m.meta) ||
      agentProposalOf(m.meta),
  );

/**
 * Reads which of the conversation's requests wait on the person, from every loaded message (not only the
 * rows on screen, which the list unmounts as they scroll away), with the same queries the cards use.
 */
export function AskProbes({ messages }: { messages: Message[] }) {
  const asking = useMemo(
    () => messages.flatMap((m, order) => (asksSomething(m) ? [{ m, order }] : [])),
    [messages],
  );
  return (
    <>
      {asking.map(({ m, order }) => (
        <AskProbe key={m.id} message={m} order={order} />
      ))}
    </>
  );
}

function AskProbe({ message: m, order }: { message: Message; order: number }) {
  const approvalId = approvalIdOf(m.meta);
  const question = questionOf(m.meta);
  const secret = secretRequestOf(m.meta);
  const handoff = browserHandoffOf(m.meta);
  const proposal = agentProposalOf(m.meta);
  return (
    <>
      {approvalId ? <ApprovalProbe id={approvalId} messageId={m.id} order={order} /> : null}
      {question ? (
        <Report
          id={question.id}
          ask={
            question.status === "open"
              ? { id: question.id, kind: "question", agentId: question.agentId, what: question.text, messageId: m.id, order }
              : null
          }
        />
      ) : null}
      {secret ? <SecretProbe request={secret} messageId={m.id} order={order} /> : null}
      {handoff ? <HandoffProbe id={handoff.id} fallback={handoff} messageId={m.id} order={order} /> : null}
      {proposal && m.author.id ? (
        <ProposalProbe
          id={m.id}
          agentId={m.author.id}
          open={proposalStatus(proposal) === "open"}
          what={proposal.params.draft.name}
          order={order}
        />
      ) : null}
    </>
  );
}

/** Puts the request in the store while it waits on the person; takes it out when it doesn't (or unmounts). */
function Report({ id, ask }: { id: string; ask: PendingAsk | null }) {
  const store = useAskStore();
  const key = ask ? `${ask.kind}|${ask.agentId}|${ask.what}|${ask.messageId}|${ask.order}` : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the request's fields
  useEffect(() => {
    if (!store) return;
    if (ask) store.put(ask);
    else store.drop(id);
  }, [store, id, key]);
  useEffect(() => () => store?.drop(id), [store, id]);
  return null;
}

function ApprovalProbe({ id, messageId, order }: { id: string; messageId: string; order: number }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const a = useApproval(orgId, id).data;
  const ask =
    a && a.status === "pending" && a.canDecide
      ? { id, kind: "approval" as const, agentId: a.agentId, what: approvalTitleText(t, a), messageId, order }
      : null;
  return <Report id={id} ask={ask} />;
}

function SecretProbe({ request: s, messageId, order }: { request: SecretRequest; messageId: string; order: number }) {
  const meId = useMeId();
  const now = useNow(60_000);
  const waits = s.status === "pending" && Date.parse(s.expiresAt) > now && s.requestedForUserId === meId;
  const ask = waits ? { id: s.id, kind: "secret" as const, agentId: s.agentId, what: s.name, messageId, order } : null;
  return <Report id={s.id} ask={ask} />;
}

function HandoffProbe({
  id,
  fallback,
  messageId,
  order,
}: {
  id: string;
  fallback: BrowserHandoff;
  messageId: string;
  order: number;
}) {
  const orgId = useOrgId();
  const meId = useMeId();
  const h = useBrowserHandoff(orgId, id).data ?? fallback;
  const waits = h.status === "pending" && h.kind === "ask" && (!h.requestedForUserId || h.requestedForUserId === meId);
  const ask = waits
    ? {
        id,
        kind: handoffScreen(h) === "desktop" ? ("desktop" as const) : ("browser" as const),
        agentId: h.agentId,
        what: h.instructions,
        messageId,
        order,
      }
    : null;
  return <Report id={id} ask={ask} />;
}

function ProposalProbe({
  id,
  agentId,
  open,
  what,
  order,
}: {
  id: string;
  agentId: string;
  open: boolean;
  what: string;
  order: number;
}) {
  const { org } = useOrg();
  const ask = open && can(org, "create_agents") ? { id, kind: "proposal" as const, agentId, what, messageId: id, order } : null;
  return <Report id={id} ask={ask} />;
}

// ── The card ─────────────────────────────────────────────────────────────────

/** The small amber square that breathes while a request waits on the person. */
export function WaitMark({ size = 8 }: { size?: number }) {
  const c = useColors();
  const reduced = useReducedMotion();
  const fade = useSharedValue(1);
  useEffect(() => {
    if (reduced) return;
    fade.value = withRepeat(withSequence(withTiming(0.55, { duration: 800 }), withTiming(1, { duration: 800 })), -1);
  }, [reduced, fade]);
  const style = useAnimatedStyle(() => ({ opacity: fade.value }));
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ width: size, height: size, borderRadius: 2, backgroundColor: c.amber }, style]}
    />
  );
}

export interface AskWell {
  /** The app or thing it goes through, as a 32-point tile. */
  tile: ReactNode;
  title: string;
  detail?: string | null;
  /** "Ver o e-mail" / "Ver detalhes" / "Ver a mudança" / "Ver a tela" and what it opens. */
  more?: { label: string; content: ReactNode } | null;
}

/**
 * The request card. `waitsFor`: "you" when the person decides (amber, breathing), a name when someone else
 * does, null to say nothing. The well holds the thing it is about; `body` sits under it (a secret's field);
 * `foot` is the strip with the expiry and the decision (`AskFoot`).
 */
export function AskCard({
  kind,
  agentId,
  waitsFor,
  lead,
  well,
  body,
  foot,
}: {
  kind: AskKind;
  agentId: string;
  waitsFor: "you" | (string & {}) | null;
  lead: string;
  well?: AskWell | null;
  body?: ReactNode;
  foot: ReactNode;
}) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const color = agentLook(dir.agentById.get(agentId)).color;
  const label = t(`ask.kind.${kind}`);
  return (
    <Animated.View
      entering={reduced ? undefined : FadeIn.duration(300)}
      style={[styles.card, { backgroundColor: c.raised, borderColor: c.line2 }]}
    >
      <Sky color={color} surface="raised" depth={0.95} fade={0} style={styles.sky} />
      {/* Label and state share a line while they fit; the state wraps under the label, never cutting it. */}
      <View style={styles.head}>
        <Text variant="footnote" tone="muted" style={styles.semibold}>
          {label}
        </Text>
        {waitsFor === "you" ? (
          <View style={styles.state}>
            <WaitMark />
            <Text variant="caption" style={[styles.semibold, { color: c.amber }]}>
              {t("ask.waitingYou")}
            </Text>
          </View>
        ) : waitsFor ? (
          <Text variant="caption" tone="muted" style={styles.semibold}>
            {t("ask.waitingFor", { name: waitsFor })}
          </Text>
        ) : null}
      </View>
      {lead ? (
        <Text variant="callout" tone="ink" style={styles.lead}>
          {lead}
        </Text>
      ) : null}
      {well ? (
        <View style={[styles.well, { backgroundColor: c.sunken }]}>
          <View style={styles.tile}>{well.tile}</View>
          <View style={styles.wellText}>
            <Text variant="small" tone="ink" numberOfLines={1} style={styles.wellTitle}>
              {well.title}
            </Text>
            {well.detail ? (
              <Text variant="footnote" tone="muted" numberOfLines={1}>
                {well.detail}
              </Text>
            ) : null}
            {well.more ? (
              // The phone has no room at the well's right: "Ver …" is its third line.
              <Pressable
                onPress={() => {
                  tapHaptic();
                  setOpen((o) => !o);
                }}
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                hitSlop={6}
                style={({ pressed }) => [styles.more, pressed && styles.pressed]}
              >
                <Text variant="footnote" tone="ink2" style={styles.semibold}>
                  {well.more.label}
                </Text>
                <View style={open ? styles.flip : undefined}>
                  <Icon name="chev" size={13} color={c.muted} />
                </View>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
      {open && well?.more ? (
        <Animated.View entering={reduced ? undefined : FadeIn.duration(220)} style={styles.exact}>
          {well.more.content}
        </Animated.View>
      ) : null}
      {body ? <View style={styles.body}>{body}</View> : null}
      {foot}
    </Animated.View>
  );
}

/** The card's last strip, edge to edge under a hairline: when it expires, then the decision. */
export function AskFoot({ expiry, children }: { expiry?: ReactNode; children?: ReactNode }) {
  const c = useColors();
  return (
    <View style={[styles.foot, { borderTopColor: c.line }]}>
      {expiry}
      {children}
    </View>
  );
}

/** The decision: the main action wide (dark) and the other beside it. */
export function AskButtons({ primary, secondary }: { primary: ReactNode; secondary?: ReactNode }) {
  return (
    <View style={styles.buttons}>
      <View style={styles.primary}>{primary}</View>
      {secondary ? <View style={styles.secondary}>{secondary}</View> : null}
    </View>
  );
}

/** The amber fuse burning to the expiry and "expira em 23 h", left-aligned; without a start, the words alone. */
export function ExpiryLine({ createdAt, expiresAt }: { createdAt?: string | null; expiresAt: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const now = useNow(15_000);
  const left = timeLeft(t, expiresAt, new Date(now));
  return (
    <View style={styles.expiry}>
      {createdAt ? (
        <View style={styles.fuse}>
          <Fuse color="amber" remaining={fuseRemaining(createdAt, expiresAt, now)} />
        </View>
      ) : null}
      <Text variant="caption" style={[styles.expiryText, { color: c.amber }]}>
        {left ? t("approval.expiresDetail", { time: left }) : t("approval.expired")}
      </Text>
    </View>
  );
}

// ── The bar ──────────────────────────────────────────────────────────────────

/**
 * The line above the composer while a request waits out of view (waiting beats working): the agent's face,
 * the breathing square, "Ada espera sua aprovação · Enviar e-mail", "+1" when more wait, and Ver, which
 * scrolls to it.
 */
export function AskBar({ away, onSee }: { away: AwayAsk; onSee: () => void }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const { colors: c, shadows } = useTheme();
  const reduced = useReducedMotion();
  const { ask, more } = away;
  const agent = dir.agentById.get(ask.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const color = agentLook(agent).color;
  const what = ask.what.replace(/\s+/g, " ").trim();
  // The name is marked to draw in ink; the string's own tags only say where it goes.
  const sentence = t(`ask.bar.${ask.kind}`, {
    name: markName(name),
    what,
    interpolation: { escapeValue: false },
  }).replace(/<\/?b>/g, "");
  const parts = markedParts(sentence);
  const plain = parts.map((p) => p.text).join("");
  const see = () => {
    tapHaptic();
    onSee();
  };
  return (
    <View style={styles.dock}>
      <Animated.View
        entering={reduced ? undefined : FadeIn.duration(160)}
        style={[styles.pill, { backgroundColor: c.glassSolid, boxShadow: `${shadows.e1}, ${shadows.top}` }]}
      >
        <Sky color={color} surface="raised" depth={0.95} fade={0} style={[StyleSheet.absoluteFill, styles.band]} />
        <View style={[styles.tok, { backgroundColor: c.glassSolid }]}>
          <AgentFace agentId={ask.agentId} size={18} mode="idle" />
        </View>
        <WaitMark />
        <Pressable
          onPress={see}
          accessibilityRole="button"
          accessibilityLabel={`${plain}. ${t("ask.bar.see")}`}
          style={styles.words}
        >
          <Text variant="caption" tone="muted" numberOfLines={1} maxFontSizeMultiplier={CHROME_MAX_SCALE}>
            {parts.map((p, i) =>
              p.bold ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one sentence, in order
                <RNText key={i} style={[styles.semibold, { color: c.ink }]}>
                  {p.text}
                </RNText>
              ) : (
                p.text
              ),
            )}
          </Text>
        </Pressable>
        {more > 0 ? (
          <Text variant="caption" tone="faint" maxFontSizeMultiplier={CHROME_MAX_SCALE}>
            {t("ask.bar.more", { count: more })}
          </Text>
        ) : null}
        <View style={[styles.sep, { backgroundColor: c.line }]} />
        <Pressable onPress={see} accessibilityElementsHidden importantForAccessibility="no" hitSlop={8}>
          <Text
            variant="caption"
            tone="ink"
            maxFontSizeMultiplier={CHROME_MAX_SCALE}
            style={[styles.semibold, styles.see, { textDecorationColor: c.line2 }]}
          >
            {t("ask.bar.see")}
          </Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Flat on the conversation (a hairline, no heavy shadow), with the app's cut corner at the bottom left.
  card: {
    marginTop: 12,
    paddingTop: 12,
    paddingHorizontal: 14,
    borderRadius: 16,
    borderBottomLeftRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  sky: { position: "absolute", top: 0, left: 0, right: 0, height: 8, opacity: 0.7 },
  head: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: 8,
    rowGap: 2,
    minHeight: 20,
  },
  state: { flexDirection: "row", alignItems: "center", gap: 6 },
  semibold: { fontWeight: "600" },
  lead: { marginTop: 8, lineHeight: 23 },
  well: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderBottomLeftRadius: 4,
  },
  tile: { marginTop: 2 },
  wellText: { flex: 1, minWidth: 0, gap: 1 },
  wellTitle: { fontWeight: "600", fontSize: 14, lineHeight: 19 },
  more: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    minHeight: 28,
    marginTop: 2,
  },
  pressed: { opacity: 0.7 },
  flip: { transform: [{ rotate: "180deg" }] },
  exact: { marginTop: 8, gap: 10 },
  body: { marginTop: 12, gap: 8 },
  foot: {
    marginTop: 14,
    marginHorizontal: -14,
    paddingTop: 12,
    paddingHorizontal: 14,
    paddingBottom: 14,
    gap: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  buttons: { flexDirection: "row", alignItems: "center", gap: 8 },
  primary: { flex: 1.5, minWidth: 0 },
  secondary: { flex: 1, minWidth: 0 },
  expiry: { flexDirection: "row", alignItems: "center", gap: 8 },
  fuse: { width: 56 },
  expiryText: { fontWeight: "500", fontVariant: ["tabular-nums"] },
  // The bar: the working line's shape (WorkingLine), so one replaces the other without moving.
  dock: { paddingHorizontal: 4, paddingBottom: 6 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 28,
    paddingHorizontal: 8,
    borderRadius: 999,
    overflow: "hidden",
  },
  band: { opacity: 0.55 },
  tok: { padding: 1.5, borderRadius: 7 },
  words: { flex: 1, minWidth: 0 },
  sep: { width: StyleSheet.hairlineWidth * 2, height: 16, marginHorizontal: 2 },
  see: { paddingHorizontal: 4, textDecorationLine: "underline" },
});
