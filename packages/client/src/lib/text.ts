/** `Acme Saúde` → `acme-saude` (display only: the backend has no slug yet). */
export const slugify = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** `Íris B.` → `irisb`: an agent @handle (2–32 chars: a-z, 0-9, - or _; see HANDLE_PATTERN in the engine). */
export function handleFrom(name: string) {
  const base = name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 32);
  return base.length >= 2 ? base : base.padEnd(2, "0");
}

export const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
export const isEmail = (value: string) => EMAIL.test(value.trim());

/** "a@x.com, b@x.com ,bad" → ["a@x.com", "b@x.com"] (deduplicated, lower case). */
export function parseEmails(value: string) {
  return [
    ...new Set(
      value
        .split(/[,;\s]+/)
        .map((e) => e.trim().toLowerCase())
        .filter(isEmail),
    ),
  ];
}

/** Password rules from Better Auth (8–128 characters, nothing else). */
export function passwordState(password: string): "empty" | "short" | "long" | "ok" {
  if (password.length === 0) return "empty";
  if (password.length < 8) return "short";
  if (password.length > 128) return "long";
  return "ok";
}

/** "40", "40,5", "40.5" → 40.5; anything else → NaN. */
export function parseAmount(value: string) {
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(normalized)) return Number.NaN;
  return Number(normalized);
}
