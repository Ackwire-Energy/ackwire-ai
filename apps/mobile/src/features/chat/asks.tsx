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
import { secretLabel } from "@agenteschat/client/lib/secret-requests";
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
import { CHROME_MAX_SCALE, Fuse, Icon, type IconName, LineIcon, Text, useReducedMotion, useTheme } from "@/ui";
import { approvalTitleText } from "../approvals/parts";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useMeId, useNow, useOrgId } from "../shared/hooks";
import { agentLook, fuseRemaining } from "../shared/logic";
import { tapHaptic, useSurface } from "../shared/parts";
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
import {
  approvalIdOf,
  LINE_GAP,
  LINE_MARK,
  lineStops,
  markedParts,
  markName,
  questionOf,
  workingEntries,
} from "./logic";
import { useOwnTop } from "./look";
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
  const { t } = useTranslation();
  const meId = useMeId();
  const dir = useDirectory();
  const expired = useExpired(s.expiresAt);
  const waits = s.status === "pending" && !expired && s.requestedForUserId === meId;
  const agent = dir.anyAgent(s.agentId)?.name ?? t("channel.unknownAgent");
  const what = secretLabel(t, s, agent);
  const ask = waits ? { id: s.id, kind: "secret" as const, agentId: s.agentId, what, messageId, order } : null;
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

/** Each kind of request by its icon on the card's top line (amber while it waits on the person); Atividade's too. */
export const ASK_ICON: Record<AskKind, IconName> = {
  approval: "shield",
  secret: "key",
  question: "help",
  browser: "globe",
  desktop: "laptop",
  proposal: "pen",
  agent: "agent",
  team: "members",
  firstTask: "target",
};

/**
 * The request card, the same as Atividade's and Conversas' waiting cards (`WaitingCard`): the app's card with its cut
 * corner, the kind on top with its icon (amber when the person decides) and, at its right, the fuse to `expiry`
 * (`ExpiryLine`) or who else decides (`waitsFor`: "esperando Ana", "Aguardando um admin"); then the request in
 * words, why it was asked in muted, and the thing it is about on one quiet line (`well`: its mark, its details and,
 * with `more`, the rest it opens). With no well, `lead` is the request itself. `body` sits under it (a secret's
 * field); `foot` holds the decision (`AskFoot`). In a conversation the card tells it where it is (`id`), for the line
 * above the composer.
 */
export function AskCard({
  id,
  kind,
  waitsFor,
  lead,
  well,
  body,
  expiry,
  foot,
}: {
  id: string;
  kind: AskKind;
  agentId: string;
  waitsFor: "you" | (string & {}) | null;
  lead: string;
  well?: AskWell | null;
  body?: ReactNode;
  /** Its deadline (`ExpiryLine`), at the top line's right while the person decides. */
  expiry?: ReactNode;
  foot?: ReactNode;
}) {
  const ownTop = useOwnTop(12);
  const { t } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  const reduced = useReducedMotion();
  const store = useAskStore();
  const slot = useRef<ComponentRef<typeof View>>(null);
  const [openHere, setOpen] = useState(false);
  const open = well?.more?.open ?? openHere;
  const toggle = () => {
    tapHaptic();
    if (well?.more?.onToggle) well.more.onToggle();
    else setOpen((o) => !o);
  };
  useLayoutEffect(() => {
    const card = slot.current;
    if (!store || !card) return;
    return store.register(id, card);
  }, [store, id]);
  const title = well ? well.title : lead;
  const why = well ? lead : null;
  const source =
    well && (well.detail || well.more) ? (
      <>
        <View style={styles.sourceMark}>{well.tile}</View>
        <Text
          variant="footnote"
          tone="faint"
          numberOfLines={well.more ? (open ? 3 : 1) : undefined}
          style={styles.grow}
        >
          {well.detail || well.more?.label}
        </Text>
        {well.more ? (
          <LineIcon variant="footnote" size={13}>
            <View style={open ? styles.flip : undefined}>
              <Icon name="chev" size={13} color={c.faint} />
            </View>
          </LineIcon>
        ) : null}
      </>
    ) : null;
  return (
    // A plain view the conversation measures (never flattened away), around the card that fades in.
    <View ref={slot} collapsable={false} style={ownTop}>
      <Animated.View entering={reduced ? undefined : FadeIn.duration(300)} style={[styles.card, surface]}>
        <View style={styles.clip}>
          <View style={styles.head}>
            <Icon name={ASK_ICON[kind]} size={13} color={waitsFor === "you" ? c.amber : c.muted} />
            <Text variant="footnote" tone="muted" numberOfLines={1} style={[styles.medium, styles.grow]}>
              {t(`ask.kind.${kind}`)}
            </Text>
            {waitsFor === "you" ? (
              expiry
            ) : waitsFor ? (
              <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.shrink}>
                {waitsFor}
              </Text>
            ) : null}
          </View>
          {title ? (
            <Text variant="title" tone="ink" numberOfLines={well && !well.more ? undefined : 4}>
              {title}
            </Text>
          ) : null}
          {why ? (
            <Text variant="small" tone="muted" style={styles.why}>
              {why}
            </Text>
          ) : null}
          {source ? (
            well?.more ? (
              <Pressable
                onPress={toggle}
                accessibilityRole="button"
                accessibilityHint={well.more.label}
                accessibilityState={{ expanded: open }}
                hitSlop={10}
                style={({ pressed }) => [styles.source, open && styles.sourceOpen, pressed && styles.pressed]}
              >
                {source}
              </Pressable>
            ) : (
              <View style={styles.source}>{source}</View>
            )
          ) : null}
          {open && well?.more ? (
            <Animated.View entering={reduced ? undefined : FadeIn.duration(220)} style={styles.exact}>
              {well.more.content}
            </Animated.View>
          ) : null}
          {body ? <View style={styles.body}>{body}</View> : null}
          {foot}
        </View>
      </Animated.View>
    </View>
  );
}

/** The card's decision, under what it asks: its buttons (and a hint under them). */
export function AskFoot({ children }: { children?: ReactNode }) {
  return <View style={styles.foot}>{children}</View>;
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

/**
 * The amber fuse burning to the expiry and the time left ("23 h"; "expira em 23 h" read aloud), for the card's top
 * line; without a start, the time alone.
 */
export function ExpiryLine({ createdAt, expiresAt }: { createdAt?: string | null; expiresAt: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const now = useNow(15_000);
  const left = timeLeft(t, expiresAt, new Date(now));
  return (
    <View
      style={styles.expiry}
      accessible
      accessibilityLabel={left ? t("approval.expiresDetail", { time: left }) : t("approval.expired")}
    >
      {createdAt ? (
        <View style={styles.fuse}>
          <Fuse color="amber" remaining={fuseRemaining(createdAt, expiresAt, now)} />
        </View>
      ) : null}
      <Text
        variant="footnote"
        numberOfLines={1}
        maxFontSizeMultiplier={CHROME_MAX_SCALE}
        style={[styles.expiryText, { color: c.amber }]}
      >
        {left || t("approval.expired")}
      </Text>
    </View>
  );
}

/**
 * A decided request: no card, one line in the conversation where the message's text starts, as every event in a
 * message is drawn: a mark on its first line (a check in green when it went through, an × when it didn't)
 * and its words (what `markName` wraps in bold) on one line. With `more`, the line opens the rest under it (and
 * the words in full); the line has no room for `label`, so it reaches screen readers as the hint.
 */
export function AskDone({
  done,
  words,
  more,
}: {
  done: boolean;
  words: string;
  more?: { label: string; content: ReactNode } | null;
}) {
  const ownTop = useOwnTop(8);
  const c = useColors();
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const line = (
    <>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.doneMark}>
        <Icon name={done ? "check" : "x"} size={LINE_MARK} color={done ? c.ok : c.faint} />
      </View>
      <Text
        variant="small"
        tone="muted"
        numberOfLines={open ? undefined : 1}
        maxFontSizeMultiplier={CHROME_MAX_SCALE}
        style={styles.doneWords}
      >
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
      </Text>
    </>
  );
  // A card turning into this line fades into it (an old one fades as it scrolls in, as the cards do).
  const enter = reduced ? undefined : FadeIn.duration(160);
  if (!more)
    return (
      <Animated.View entering={enter} style={[styles.done, ownTop]}>
        {line}
      </Animated.View>
    );
  return (
    <Animated.View entering={enter}>
      <Pressable
        onPress={() => {
          tapHaptic();
          setOpen((o) => !o);
        }}
        accessibilityRole="button"
        accessibilityHint={more.label}
        accessibilityState={{ expanded: open }}
        hitSlop={12}
        style={({ pressed }) => [styles.done, ownTop, pressed && styles.pressed]}
      >
        {line}
        <View style={[styles.doneMark, open ? styles.flip : undefined]}>
          <Icon name="chev" size={13} color={c.faint} />
        </View>
      </Pressable>
      {open ? (
        <Animated.View entering={reduced ? undefined : FadeIn.duration(220)} style={styles.doneMore}>
          {more.content}
        </Animated.View>
      ) : null}
    </Animated.View>
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
  // "See" scrolls to the card: no haptic.
  const see = onSee;
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
          style={({ pressed }) => [styles.words, pressed && styles.pressed]}
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
        <Pressable
          onPress={see}
          accessibilityElementsHidden
          importantForAccessibility="no"
          hitSlop={8}
          style={({ pressed }) => pressed && styles.pressed}
        >
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
  // The app's card (`useSurface`) with its cut corner at the bottom left, as the waiting cards.
  card: { borderRadius: 20, borderBottomLeftRadius: 6 },
  clip: {
    borderRadius: 20,
    borderBottomLeftRadius: 6,
    overflow: "hidden",
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 8,
  },
  head: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 18 },
  semibold: { fontWeight: "600" },
  medium: { fontWeight: "500" },
  grow: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  why: { marginTop: -4 },
  // The thing it is about, one quiet line: its mark, its details, the chevron when it opens more.
  source: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "stretch", minHeight: 24 },
  // Open, its details take up to three lines: the mark and the chevron stay on the first.
  sourceOpen: { alignItems: "flex-start" },
  sourceMark: { flexShrink: 0 },
  pressed: { opacity: 0.7 },
  flip: { transform: [{ rotate: "180deg" }] },
  exact: { gap: 10 },
  body: { gap: 8 },
  foot: { marginTop: 4, gap: 10 },
  buttons: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  primary: { flexGrow: 1.5, flexShrink: 1, minWidth: 0 },
  secondary: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  expiry: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 0 },
  fuse: { width: 44 },
  expiryText: { flexShrink: 1, fontWeight: "500", fontVariant: ["tabular-nums"] },
  // A decided request: an event line on the conversation itself, nothing around it; the mark on the first line's
  // reading middle (a 20-point line), the words to the end of the column.
  done: { flexDirection: "row", alignItems: "flex-start", gap: LINE_GAP, alignSelf: "stretch" },
  doneMark: { height: 20, justifyContent: "center" },
  doneWords: { flex: 1, minWidth: 0 },
  // Under the words, not the mark.
  doneMore: { marginTop: 6, marginLeft: LINE_MARK + LINE_GAP, gap: 4 },
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
