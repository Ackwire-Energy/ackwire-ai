import { isAppLocale } from "@agenteschat/i18n/locale";
import { createFileRoute } from "@tanstack/react-router";
import type { LocaleCode } from "@/i18n";
import { HelpPage } from "@/pages/help/HelpPage";

/** A help page, public: every edition and app links here with the reader's language (`helpUrl`). */
export const Route = createFileRoute("/help/$slug")({
  // Always returns `lang`: a key left out would pass the address's own value through unchecked.
  validateSearch: (search: Record<string, unknown>): { lang?: LocaleCode } => ({
    lang: isAppLocale(search.lang) ? search.lang : undefined,
  }),
  component: function Help() {
    const { slug } = Route.useParams();
    const { lang } = Route.useSearch();
    return <HelpPage slug={slug} lang={lang} />;
  },
});
