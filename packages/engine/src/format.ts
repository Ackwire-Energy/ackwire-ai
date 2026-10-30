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
