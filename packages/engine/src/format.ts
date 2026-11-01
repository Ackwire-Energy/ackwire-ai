/**
 * At most `max` UTF-16 units of `text`, never half of a pair (an emoji) at the end: Postgres refuses jsonb that
 * holds a lone surrogate.
 */
export const cutText = (text: string, max: number) => text.slice(0, max).replace(/[\uD800-\uDBFF]$/, "");

/** `cutText` from the end: the last `max` units, never half of a pair at the start. */
export const cutTextEnd = (text: string, max: number) =>
  text.slice(Math.max(0, text.length - max)).replace(/^[\uDC00-\uDFFF]/, "");

/** `2.3 MB`, `12 KB`, `512 bytes`, `50.0 GB`: sizes in the English agents read. */
export function formatBytes(n: number) {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * A moment as a person reads it in their time zone and language: the day ("November 6, 2026", "6 de novembro de
 * 2026") and the time with its zone ("3:42 PM GMT-3", "15:42 BRT").
 */
export function dayAndTime(at: Date, timeZone: string, locale: "en" | "pt-BR") {
  const tag = locale === "en" ? "en-US" : "pt-BR";
  return {
    day: new Intl.DateTimeFormat(tag, { timeZone, dateStyle: "long" }).format(at),
    time: new Intl.DateTimeFormat(tag, { timeZone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(
      at,
    ),
  };
}

/** `text` in at most `max` characters, cut after the last whole word that fits (a first word longer than that, inside it). */
export function fitWords(text: string, max: number) {
  if (text.length <= max) return text;
  const space = text.slice(0, max + 1).lastIndexOf(" ");
  return (space > 0 ? text.slice(0, space) : text.slice(0, max)).replace(/[\s,;:·-]+$/, "");
}

/** Levenshtein distance: the fewest one-character insertions, deletions or substitutions from `a` to `b`. */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const sub = (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      row.push(Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, sub));
    }
    prev = row;
  }
  return prev[b.length] as number;
}
