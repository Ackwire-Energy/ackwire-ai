/**
 * An @handle that is an id another app gave its agent, not one someone chose: it holds the start of a UUID
 * (`agent-e9665a97-c8d5-423f-ae59-25`, an OpenBot.run id cut to our 32 characters).
 */
export const isIdHandle = (handle: string) => /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(handle);

/** 1–2 letters: "Ada" → "A"; "Marina Souza" → "MS". */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0]?.[0] ?? "?").toUpperCase();
  return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
}
