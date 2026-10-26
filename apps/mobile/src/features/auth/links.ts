/** An invitation token from a link: what the server issues (url-safe base64), nothing else. Pure. */
export const isInviteToken = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{16,200}$/.test(value);
