/**
 * "Marina está digitando…": who is typing per channel, from `user.typing`
 * events, each valid for `ttlMs`. And the
 * throttle for sending our own typing frames.
 */
export const TYPING_TTL_MS = 6000;
export const TYPING_SEND_EVERY_MS = 3000;

export type TypingState = Record<string, Record<string, number>>;

export function applyTyping(
  state: TypingState,
  channelId: string,
  userId: string,
  now: number,
  ttlMs = TYPING_TTL_MS,
): TypingState {
  return { ...state, [channelId]: { ...state[channelId], [userId]: now + ttlMs } };
}

/** Someone's message arrived: they stopped typing. */
export function stopTyping(state: TypingState, channelId: string, userId: string): TypingState {
  const current = state[channelId];
  if (!current?.[userId]) return state;
  const { [userId]: _u, ...rest } = current;
  return { ...state, [channelId]: rest };
}

export const typingIn = (state: TypingState, channelId: string, now: number, exceptUserId?: string) =>
  Object.entries(state[channelId] ?? {})
    .filter(([id, until]) => until > now && id !== exceptUserId)
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
