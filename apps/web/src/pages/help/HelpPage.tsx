import { useAuthConfig } from "@agenteschat/client";
import { HELP, type HelpBlock, helpDocument, helpInline, isHelpSlug } from "@agenteschat/i18n/help";
import { isAppLocale } from "@agenteschat/i18n/locale";
import { Logo, Select } from "@agenteschat/ui";
import { Link, Navigate, useNavigate } from "@tanstack/react-router";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_LOCALE, type LocaleCode, locales, usePageT } from "@/i18n";
import { useDocumentTitle } from "@/lib/desktop";
import "../legal.css";
import "./help.css";

/**
 * A help page (`/help/<slug>`): the background reading a screen of the app links to once, public, laid out like the
 * Terms (`LegalPage`). In the language of the link's `?lang=`, else the app's; an unknown page goes to `/`.
 */
export function HelpPage({ slug, lang }: { slug: string; lang?: LocaleCode }) {
  const { i18n } = useTranslation();
  const navigate = useNavigate();
  const locale: LocaleCode = lang ?? (isAppLocale(i18n.language) ? i18n.language : DEFAULT_LOCALE);
  const t = usePageT(locale);
  const config = useAuthConfig().data;
  const doc = isHelpSlug(slug) ? helpDocument(slug, locale) : null;
  useDocumentTitle(doc ? `${doc.title} · agentes.chat` : undefined);
  if (!doc) return <Navigate to="/" replace />;

  // The page's language only (its link's `?lang=`): the app's own is picked in Settings.
  const switchTo = (code: LocaleCode) =>
    void navigate({ to: "/help/$slug", params: { slug }, search: { lang: code }, replace: true });
  // The page's own language: English where `locale` has no translation of it yet.
  const shown = isHelpSlug(slug) && HELP[locale][slug] ? locale : DEFAULT_LOCALE;
  return (
    <div className="legal help" lang={shown}>
      <header className="legal__bar">
        <Link to="/" aria-label={t("legal.home")}>
          <Logo size={24} />
        </Link>
        <Select
          size="sm"
          aria-label={t("shell.language")}
          value={locale}
          onValueChange={(v) => switchTo(v as LocaleCode)}
          options={locales.map((l) => ({ value: l.code, label: l.label }))}
        />
      </header>
      <main className="page page--narrow">
        <header className="legal__head">
          <h1 className="page-title">{doc.title}</h1>
          <p className="page-sub">{doc.summary}</p>
        </header>
        <article className="md help__doc">
          {doc.sections.map((s) => (
            <section key={s.id} id={s.id}>
              <h2>{s.heading}</h2>
              {s.blocks.map((b, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the text is fixed, its order never changes
                <Block key={i} block={b} />
              ))}
            </section>
          ))}
        </article>
        {config?.termsUrl && config.privacyUrl && (
          <footer className="legal__foot help__foot">
            <a href={config.termsUrl}>{t("auth.terms")}</a>
            <a href={config.privacyUrl}>{t("auth.privacy")}</a>
          </footer>
        )}
      </main>
    </div>
  );
}

/** One block of a help page: a paragraph, a list, or a command to copy (scrolling inside itself). */
export function Block({ block }: { block: HelpBlock }) {
  if (typeof block === "string")
    return (
      <p>
        <Inline line={block} />
      </p>
    );
  if ("code" in block)
    return (
      <pre className="md__code">
        <code>{block.code}</code>
      </pre>
    );
  return (
    <ul>
      {block.list.map((item) => (
        <li key={item}>
          <Inline line={item} />
        </li>
      ))}
    </ul>
  );
}

function Inline({ line }: { line: string }) {
  return helpInline(line).map((p, i) =>
    p.kind === "bold" ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: pieces of one fixed line
      <strong key={i}>{p.text}</strong>
    ) : p.kind === "code" ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: pieces of one fixed line
      <code key={i}>{p.text}</code>
    ) : p.kind === "link" ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: pieces of one fixed line
      <a key={i} href={p.href} className="ac-link">
        {p.text}
      </a>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: pieces of one fixed line
      <Fragment key={i}>{p.text}</Fragment>
    ),
  );
}
