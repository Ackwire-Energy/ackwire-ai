/**
 * "Marina está digitando…": who is typing per channel, from `user.typing`
 * events, each valid for `ttlMs`, and where (a thread's id, null in the
 * conversation itself). And the throttle for sending our own typing frames.
 */
export const TYPING_TTL_MS = 6000;
export const TYPING_SEND_EVERY_MS = 3000;

export type TypingState = Record<string, Record<string, { until: number; threadId: string | null }>>;

export function applyTyping(
  state: TypingState,
  channelId: string,
  userId: string,
  now: number,
  ttlMs = TYPING_TTL_MS,
  threadId: string | null = null,
): TypingState {
  return { ...state, [channelId]: { ...state[channelId], [userId]: { until: now + ttlMs, threadId } } };
}

/** Someone's message arrived: they stopped typing. */
export function stopTyping(state: TypingState, channelId: string, userId: string): TypingState {
  const current = state[channelId];
  if (!current?.[userId]) return state;
  const { [userId]: _u, ...rest } = current;
  return { ...state, [channelId]: rest };
}

/** Without the typing that ran out by `now` (the same state when none did): a store can drop it on time. */
export function expireTyping(state: TypingState, now: number): TypingState {
  let next = state;
  for (const [channelId, users] of Object.entries(state)) {
    const live = Object.entries(users).filter(([, at]) => at.until > now);
    if (live.length < Object.keys(users).length) next = { ...next, [channelId]: Object.fromEntries(live) };
  }
  return next;
}

/** Who is typing in the conversation itself (`threadId` null) or in one of its threads. */
export const typingIn = (
  state: TypingState,
  channelId: string,
  now: number,
  exceptUserId?: string,
  threadId: string | null = null,
) =>
  Object.entries(state[channelId] ?? {})
    .filter(([id, at]) => at.until > now && at.threadId === threadId && id !== exceptUserId)
    .map(([id]) => id);

/** Returns a function that says whether to send a typing frame now (at most one every 3 s). */
export function typingThrottle(every = TYPING_SEND_EVERY_MS) {
  let last = Number.NEGATIVE_INFINITY;
  return (now: number) => {
    if (now - last < every) return false;
    last = now;
    return true;
  };
}
