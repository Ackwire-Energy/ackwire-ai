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

/** Common misspellings of webmail domains (the sign-in screen offers the fix). */
const DOMAIN_TYPOS: Record<string, string> = {
  "gmial.com": "gmail.com",
  "gmai.com": "gmail.com",
  "gmal.com": "gmail.com",
  "gamil.com": "gmail.com",
  "gnail.com": "gmail.com",
  "gmail.con": "gmail.com",
  "gmail.co": "gmail.com",
  "gmail.com.br": "gmail.com",
  "hotmial.com": "hotmail.com",
  "hotmai.com": "hotmail.com",
  "hotmail.con": "hotmail.com",
  "outlok.com": "outlook.com",
  "outllok.com": "outlook.com",
  "outlook.con": "outlook.com",
  "yaho.com": "yahoo.com",
  "yahoo.con": "yahoo.com",
  "icloud.con": "icloud.com",
  "icoud.com": "icloud.com",
  "uol.com": "uol.com.br",
  "bol.com": "bol.com.br",
};

/** `ana@gmial.com` → `ana@gmail.com`; null when the domain looks right. */
export function emailTypoFix(email: string): string | null {
  const [user, domain, ...rest] = email.trim().toLowerCase().split("@");
  if (!user || !domain || rest.length) return null;
  const fixed = DOMAIN_TYPOS[domain];
  return fixed ? `${user}@${fixed}` : null;
}

/** Where to read the e-mail we just sent: the webmail of known domains ("Abrir o Gmail"). */
export function webmailOf(email: string): { name: "Gmail" | "Outlook" | "iCloud Mail" | "Yahoo Mail"; url: string } | null {
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  if (domain === "gmail.com" || domain === "googlemail.com") return { name: "Gmail", url: "https://mail.google.com" };
  if (["outlook.com", "hotmail.com", "live.com", "msn.com"].includes(domain))
    return { name: "Outlook", url: "https://outlook.live.com/mail" };
  if (["icloud.com", "me.com", "mac.com"].includes(domain)) return { name: "iCloud Mail", url: "https://www.icloud.com/mail" };
  if (domain.startsWith("yahoo.")) return { name: "Yahoo Mail", url: "https://mail.yahoo.com" };
  return null;
}
