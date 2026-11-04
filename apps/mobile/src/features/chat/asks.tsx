import {
  type AgentProposalCard,
  type BrowserHandoff,
  browserHandoffOf,
  handoffIsMine,
  handoffScreen,
  type LiveConsult,
  type LiveRun,
  type Message,
  type SecretRequest,
  useApproval,
  useBrowserHandoff,
  useCardProposals,
} from "@agenteschat/client";
import { agentProposalOf, proposalStatus } from "@agenteschat/client/lib/action-cards";
import { entriesOffScreen } from "@agenteschat/client/lib/activity";
import { timeLeft } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { isOpen, messageProposalCards, proposalTarget, proposerOf } from "@agenteschat/client/lib/proposals";
import {
  type ComponentRef,
  createContext,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text as RNText, StyleSheet, useWindowDimensions, View } from "react-native";
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
import { useColors, useDirectory, useMeId, useNow, useOrgId, useWhen } from "../shared/hooks";
import { agentLook, fuseRemaining } from "../shared/logic";
import { tapHaptic } from "../shared/parts";
import {
  type AskKind,
  type AskStore,
  type AwayAsk,
  approvalMayWait,
  cardShows,
  type Measurable,
  mayAsk,
  type PendingAsk,
  secretRequestOf,
  timerDelay,
} from "./ask-store";
import { LineStop, useRowsInView } from "./LiveRows";
import { approvalIdOf, lineStops, markedParts, markName, questionOf, workingEntries } from "./logic";
import type { RowSight } from "./row-sight";

/**
 * A request in the conversation (an approval, a secret, a question, help in the agent's browser or on its
 * computer, a proposal) is one card for all: what it asks in a small label with its state, the agent's own
 * words, the thing it is about in a well (whole under "Ver …"), then a strip with when it expires and the
 * decision. Decided, it is one quiet line (`AskDone`). While one waits out of view, the line above the composer
 * says so and takes the person to it. What waits and what shows is kept in `ask-store.ts`.
 */

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

/** Whether `at` has passed, turning true right at that moment: one timer to it, no polling. */
export function useExpired(at: string | null | undefined): boolean {
  const ms = at ? Date.parse(at) : Number.NaN;
  const [now, setNow] = useState(Date.now);
  const expired = Number.isFinite(ms) && now >= ms;
  useEffect(() => {
    if (!Number.isFinite(ms) || expired) return;
    let timer: ReturnType<typeof setTimeout>;
    // A time farther away than a timer reaches is waited for in steps.
    const wait = () => {
      timer = setTimeout(() => (Date.now() >= ms ? setNow(Date.now()) : wait()), timerDelay(ms, Date.now()));
    };
    wait();
    return () => clearTimeout(timer);
  }, [ms, expired]);
  return expired;
}

// ── Which requests wait here ─────────────────────────────────────────────────

/**
 * Reads which of the conversation's requests wait on the person, from every loaded message (not only the
 * rows on screen, which the list unmounts as they scroll away), with the same queries the cards use. The scan
 * reads keys only; a message's probe draws again only when the message or its place changes, not on every
 * word an agent streams.
 */
export function AskProbes({ messages }: { messages: Message[] }) {
  const asking = useMemo(() => messages.flatMap((m, order) => (mayAsk(m) ? [{ m, order }] : [])), [messages]);
  return (
    <>
      {asking.map(({ m, order }) => (
        <AskProbe key={m.id} message={m} order={order} />
      ))}
    </>
  );
}

const AskProbe = memo(function AskProbe({ message: m, order }: { message: Message; order: number }) {
  const approvalId = approvalIdOf(m.meta);
  const question = questionOf(m.meta);
  const secret = secretRequestOf(m.meta);
  const handoff = browserHandoffOf(m.meta);
  const proposal = agentProposalOf(m.meta);
  const changes = messageProposalCards(m.meta);
  const asked: PendingAsk | null =
    question?.status === "open"
      ? { id: question.id, kind: "question", agentId: question.agentId, what: question.text, messageId: m.id, order }
      : null;
  return (
    <>
      {/* An approval expires in a day: an older message's can't wait any more, so it isn't asked for. */}
      {approvalId && approvalMayWait(m.createdAt, Date.now()) ? (
        <ApprovalProbe id={approvalId} messageId={m.id} order={order} />
      ) : null}
      {question ? <Report id={question.id} ask={asked} /> : null}
      {secret ? <SecretProbe request={secret} messageId={m.id} order={order} /> : null}
      {/* The card's own copy says when a request ended (the server keeps it, and live events patch it): only an
          open one is asked about. */}
      {handoff?.status === "pending" ? (
        <HandoffProbe id={handoff.id} fallback={handoff} messageId={m.id} order={order} />
      ) : null}
      {proposal && m.author.id ? (
        <ProposalProbe card={proposal} agentId={m.author.id} messageId={m.id} order={order} />
      ) : null}
      {changes.map((ids) => (
        <ChangeProposalProbe key={ids.join(",")} ids={ids} messageId={m.id} order={order} />
      ))}
    </>
  );
});

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
  const expired = useExpired(a?.expiresAt);
  const ask =
    a && a.status === "pending" && a.canDecide && !expired
      ? { id, kind: "approval" as const, agentId: a.agentId, what: approvalTitleText(t, a), messageId, order }
      : null;
  return <Report id={id} ask={ask} />;
}

function SecretProbe({ request: s, messageId, order }: { request: SecretRequest; messageId: string; order: number }) {
  const meId = useMeId();
  const expired = useExpired(s.expiresAt);
  const waits = s.status === "pending" && !expired && s.requestedForUserId === meId;
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
  const { orgId, org } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const h = useBrowserHandoff(orgId, id).data ?? fallback;
  const expired = useExpired(h.expiresAt);
  // The same rule as its card (`HandoffCard`): by ids, never by a name that may not have loaded.
  const mine = meId !== null && handoffIsMine(h, meId, dir.agentById.get(h.agentId)?.ownerUserId, org);
  const ask =
    h.status === "pending" && h.kind === "ask" && !expired && mine
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

/** An agent's proposal of a new agent: who may create agents decides it until it expires. */
function ProposalProbe({
  card,
  agentId,
  messageId,
  order,
}: {
  card: AgentProposalCard;
  agentId: string;
  messageId: string;
  order: number;
}) {
  const { org } = useOrg();
  const expired = useExpired(card.expiresAt);
  const ask =
    !expired && proposalStatus(card) === "open" && can(org, "create_agents")
      ? { id: messageId, kind: "agent" as const, agentId, what: card.params.draft.name, messageId, order }
      : null;
  return <Report id={messageId} ask={ask} />;
}

/**
 * A proposal card of the agent's (a change to the context or to agents' instructions, roles or apps, for one agent or
 * several): one request while any of its rows waits on the person. Its id is the card's (`InstructionProposals`).
 */
function ChangeProposalProbe({ ids, messageId, order }: { ids: string[]; messageId: string; order: number }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const rows = useCardProposals(orgId, ids);
  const open = rows.find((p) => isOpen(p) && p.canDecide);
  const id = ids.join(",");
  const agentName = (a: string) => dir.anyAgent(a)?.name ?? t("channel.unknownAgent");
  const ask = open
    ? {
        id,
        kind: "proposal" as const,
        agentId: proposerOf(open),
        what: proposalTarget(t, open, agentName, org?.name ?? ""),
        messageId,
        order,
      }
    : null;
  return <Report id={id} ask={ask} />;
}

// ── What shows ───────────────────────────────────────────────────────────────

/** What the conversation tells the requests' watch about its list. */
export interface AskView {
  /** The view the list fills: the band is measured from its frame in the window. */
  frame: () => Measurable | null;
  /** The band inside that frame, from its top and from its bottom (the header, the composer); null until placed. */
  insets: () => { top: number; bottom: number } | null;
  /** Whether the list draws this message's row now: a card it doesn't draw is out of view. */
  drawn: (messageId: string) => boolean;
}

/**
 * Which waiting requests are out of view, for the line above the composer (the web's rule): a request shows while
 * 40 points of its card do, between the floating header and the composer. A look is asked for on a scroll (one a
 * frame), on layout and when the list's size changes; it measures only the waiting requests' cards, and the store
 * publishes only when the set changes. Nothing runs while no request waits. Returns the call that asks for a look.
 */
export function useAskWatch(store: AskStore, view: AskView): () => void {
  const viewRef = useRef(view);
  viewRef.current = view;
  const frame = useRef<number | null>(null);
  const look = useRef(0);
  const watch = useCallback(() => {
    if (frame.current !== null || !store.hasWaiting()) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      look.current += 1;
      lookAtAsks(store, viewRef.current, look.current, () => look.current);
    });
  }, [store]);
  // A request came, or its card was drawn or went.
  useEffect(() => store.watch(watch), [store, watch]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `view.insets` changes when the band's edges move
  useEffect(() => {
    watch();
  }, [watch, view.insets]);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  return watch;
}

/** One look at the waiting requests' cards against the list's band; a newer look drops an older one's answers. */
function lookAtAsks(store: AskStore, view: AskView, look: number, latest: () => number) {
  const waiting = store.waiting();
  const insets = view.insets();
  const box = view.frame();
  if (waiting.length === 0 || !insets || !box) return;
  box.measureInWindow((_x, y, _width, height) => {
    if (look !== latest() || !(height > 0)) return;
    const band = { top: y + insets.top, bottom: y + height - insets.bottom };
    const hidden: string[] = [];
    let left = waiting.length;
    const counted = () => {
      left -= 1;
      if (left === 0 && look === latest()) store.setHidden(hidden);
    };
    for (const ask of waiting) {
      const card = store.cardOf(ask.id);
      if (card) {
        card.measureInWindow((_cx, cy, _cw, ch) => {
          if (!cardShows(cy, ch, band)) hidden.push(ask.id);
          counted();
        });
        continue;
      }
      // No card: out of view when the list doesn't draw its row; a row it draws gets its card in a moment.
      if (!view.drawn(ask.messageId)) hidden.push(ask.id);
      counted();
    }
  });
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
  /**
   * "Ver o e-mail" / "Ver detalhes" / "Ver a mudança" / "Ver a tela" and what it opens; `open` and `onToggle` when its
   * owner keeps that state (a run of approvals, open still once its card reshapes).
   */
  more?: { label: string; content: ReactNode; open?: boolean; onToggle?: () => void } | null;
}

/**
 * The request card. `waitsFor`: "you" when the person decides (amber, breathing), what to say when someone else
 * does ("esperando Ana", "Aguardando um admin"), null to say nothing. The well holds the thing it is about; `body`
 * sits under it (a secret's field); `foot` is the strip with the expiry and the decision (`AskFoot`), none when
 * there is neither. In a conversation the card tells it where it is (`id`), for the line above the composer.
 */
export function AskCard({
  id,
  kind,
  agentId,
  waitsFor,
  lead,
  well,
  body,
  foot,
}: {
  id: string;
  kind: AskKind;
  agentId: string;
  waitsFor: "you" | (string & {}) | null;
  lead: string;
  well?: AskWell | null;
  body?: ReactNode;
  foot?: ReactNode;
}) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  const reduced = useReducedMotion();
  const store = useAskStore();
  const slot = useRef<ComponentRef<typeof View>>(null);
  const [openHere, setOpen] = useState(false);
  const open = well?.more?.open ?? openHere;
  const color = agentLook(dir.agentById.get(agentId)).color;
  const label = t(`ask.kind.${kind}`);
  useLayoutEffect(() => {
    const card = slot.current;
    if (!store || !card) return;
    return store.register(id, card);
  }, [store, id]);
  return (
    // A plain view the conversation measures (never flattened away), around the card that fades in.
    <View ref={slot} collapsable={false} style={styles.slot}>
      <Animated.View
        entering={reduced ? undefined : FadeIn.duration(300)}
        style={[styles.card, !foot && styles.footless, { backgroundColor: c.raised, borderColor: c.line2 }]}
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
              {waitsFor}
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
              <Text variant="small" tone="ink" numberOfLines={2} style={styles.wellTitle}>
                {well.title}
              </Text>
              {well.detail ? (
                <Text variant="footnote" tone="muted" numberOfLines={3}>
                  {well.detail}
                </Text>
              ) : null}
              {well.more ? (
                // The phone has no room at the well's right: "Ver …" is its third line.
                <Pressable
                  onPress={() => {
                    tapHaptic();
                    if (well.more?.onToggle) well.more.onToggle();
                    else setOpen((o) => !o);
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
    </View>
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

/**
 * The decision: the main action wide (dark) and the other beside it, or under it when both don't fit their words
 * (a narrow phone, a larger text size): each keeps a least width that grows with the text, and the row wraps.
 */
export function AskButtons({ primary, secondary }: { primary: ReactNode; secondary?: ReactNode }) {
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(2, Math.max(1, fontScale));
  return (
    <View style={styles.buttons}>
      <View style={[styles.primary, { flexBasis: 128 * scale }]}>{primary}</View>
      {secondary ? <View style={[styles.secondary, { flexBasis: 96 * scale }]}>{secondary}</View> : null}
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

/**
 * A decided request: no card, one quiet line in the conversation. A pixel mark (a green square when it went through,
 * a bar when it didn't), its words (what `markName` wraps in bold) and, with `at`, when it ended. The words wrap
 * rather than lose the outcome. With `more`, the line opens the rest under it; the line has no room for `label`, so
 * it reaches screen readers as the hint.
 */
export function AskDone({
  done,
  words,
  at,
  more,
}: {
  done: boolean;
  words: string;
  at?: string | null;
  more?: { label: string; content: ReactNode };
}) {
  const c = useColors();
  const when = useWhen();
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const line = (
    <>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.doneMark}>
        <View style={[done ? styles.donePixel : styles.doneBar, { backgroundColor: done ? c.ok : c.faint }]} />
      </View>
      <Text variant="small" tone="muted" maxFontSizeMultiplier={CHROME_MAX_SCALE} style={styles.doneWords}>
        {markedParts(words).map((p, i) =>
          p.bold ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one sentence, in order
            <RNText key={i} style={[styles.semibold, { color: c.ink2 }]}>
              {p.text}
            </RNText>
          ) : (
            p.text
          ),
        )}
        {at ? ` · ${when.short(at)}` : null}
      </Text>
    </>
  );
  if (!more) return <View style={styles.done}>{line}</View>;
  return (
    <>
      <Pressable
        onPress={() => {
          tapHaptic();
          setOpen((o) => !o);
        }}
        accessibilityRole="button"
        accessibilityHint={more.label}
        accessibilityState={{ expanded: open }}
        hitSlop={8}
        style={({ pressed }) => [styles.done, pressed && styles.pressed]}
      >
        {line}
        <View style={open ? styles.flip : undefined}>
          <Icon name="chev" size={13} color={c.muted} />
        </View>
      </Pressable>
      {open ? (
        <Animated.View entering={reduced ? undefined : FadeIn.duration(220)}>{more.content}</Animated.View>
      ) : null}
    </>
  );
}

// ── The bar ──────────────────────────────────────────────────────────────────

/**
 * The line above the composer while a request waits out of view (waiting beats working): the agent's face,
 * the breathing square, "Ada espera sua aprovação · Enviar e-mail", "+1" when more wait, and Ver, which
 * scrolls to it. While one agent works here with its live row out of view, the working line's "Parar" stays at its
 * end (a row on screen carries its own).
 */
export function AskBar({
  away,
  onSee,
  runs,
  consults,
  canStop,
  onStop,
  sight,
}: {
  away: AwayAsk;
  onSee: () => void;
  /** The work going on here, as the working line gets it: its stop follows the same rule. */
  runs: LiveRun[];
  consults: LiveConsult[];
  canStop: (run: LiveRun) => boolean;
  onStop: (run: LiveRun) => void;
  /** Which agents' live rows are on screen (theirs carry their stop). */
  sight: RowSight;
}) {
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
  const inView = useRowsInView(sight);
  const rowInView = (r: LiveRun) => inView.has(r.runId);
  const stops = lineStops(
    entriesOffScreen(
      workingEntries(runs, consults, (id) => dir.agentById.get(id)?.name ?? ""),
      runs,
      rowInView,
    ),
    runs,
    canStop,
    rowInView,
  );
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
        <LineStop runs={stops} onStop={onStop} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  slot: { marginTop: 12 },
  // Flat on the conversation (a hairline, no heavy shadow), with the app's cut corner at the bottom left.
  card: {
    paddingTop: 12,
    paddingHorizontal: 14,
    borderRadius: 16,
    borderBottomLeftRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  // No strip to close it (nothing to decide here, no expiry): the card's own padding does.
  footless: { paddingBottom: 14 },
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
  buttons: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  primary: { flexGrow: 1.5, flexShrink: 1, minWidth: 0 },
  secondary: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  expiry: { flexDirection: "row", alignItems: "center", gap: 8 },
  fuse: { width: 56 },
  expiryText: { flexShrink: 1, fontWeight: "500", fontVariant: ["tabular-nums"] },
  // A decided request: a line on the conversation itself, nothing around it.
  done: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    alignSelf: "flex-start",
    maxWidth: "100%",
    marginTop: 6,
  },
  doneMark: { width: 14, height: 14, alignItems: "center", justifyContent: "center" },
  donePixel: { width: 5, height: 5 },
  doneBar: { width: 8, height: 2 },
  doneWords: { flexShrink: 1, fontSize: 14, lineHeight: 19 },
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
