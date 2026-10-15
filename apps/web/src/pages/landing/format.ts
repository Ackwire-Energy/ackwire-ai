import { useMemo } from "react";
import { useTranslation } from "react-i18next";

/** The sample month of the page (the example data is from October 2026). */
const SAMPLE_DAY = (day = 14, h = 12, m = 0) => new Date(2026, 9, day, h, m);

/** Numbers, money, times and dates of the landing page, in the active language (Intl). */
export function useFormat() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === "en" ? "en" : "pt-BR";
  return useMemo(() => {
    const nf = (digits: number) =>
      new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return {
      locale,
      num: (n: number, digits = 0) => nf(digits).format(n),
      /** "US$ 0,021" (pt-BR), "US$0.021" (en). */
      usd: (n: number, digits = 2) => t("landing.money", { value: nf(digits).format(n) }),
      time: (h: number, m: number) =>
        new Intl.DateTimeFormat(locale, { hour: locale === "en" ? "numeric" : "2-digit", minute: "2-digit" }).format(
          SAMPLE_DAY(14, h, m),
        ),
      timeOf: (d: Date) =>
        new Intl.DateTimeFormat(locale, { hour: locale === "en" ? "numeric" : "2-digit", minute: "2-digit" }).format(d),
      month: () => new Intl.DateTimeFormat(locale, { month: "long" }).format(SAMPLE_DAY()),
      /** Short weekday of the sample week, 0 = Monday, 12 October 2026. */
      weekday: (i: number) =>
        new Intl.DateTimeFormat(locale, { weekday: "short" }).format(SAMPLE_DAY(12 + i)).replace(/\.$/, ""),
      /** "4 s", "1 min 48 s". */
      dur: (seconds: number) =>
        seconds < 60
          ? t("landing.dur.s", { s: seconds })
          : t("landing.dur.m", { m: Math.floor(seconds / 60), s: seconds % 60 }),
    };
  }, [locale, t]);
}
export type Format = ReturnType<typeof useFormat>;
