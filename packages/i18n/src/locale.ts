/** The app's languages: pt-BR is the default, English the alternative. */
export type AppLocale = "pt-BR" | "en";

/** The first of these tags (most preferred first) the app speaks: "pt-PT" → pt-BR, "en-GB" → en; else null. */
export function appLocale(tags: readonly (string | null | undefined)[]): AppLocale | null {
  for (const tag of tags) {
    const t = (tag ?? "").toLowerCase();
    if (t.startsWith("pt")) return "pt-BR";
    if (t.startsWith("en")) return "en";
  }
  return null;
}
