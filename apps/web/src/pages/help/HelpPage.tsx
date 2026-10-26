import { type HelpBlock, helpDocument, helpInline, isHelpSlug } from "@agenteschat/i18n/help";
import { Button, Logo, Segmented } from "@agenteschat/ui";
import { Link, Navigate, useNavigate } from "@tanstack/react-router";
import { Fragment, useRef } from "react";
import { useTranslation } from "react-i18next";
import { type LocaleCode, setLocale, usePageT } from "@/i18n";
import { useDocumentTitle } from "@/lib/desktop";
import { Footer } from "@/pages/landing/Footer";
import { useLandingTheme } from "@/pages/landing/hooks";
import { LpIcon } from "@/pages/landing/icons";
import "@/pages/landing/landing.css";
import "./help.css";

/**
 * A help page (`/help/<slug>`): the background reading a screen of the app links to once, public, in the landing's
 * look and themes. In the language of the link's `?lang=`, else the app's; an unknown page goes to `/`.
 */
export function HelpPage({ slug, lang }: { slug: string; lang?: LocaleCode }) {
  const { i18n } = useTranslation();
  const navigate = useNavigate();
  const root = useRef<HTMLDivElement>(null);
  const { theme, toggleTheme } = useLandingTheme(root);
  const locale: LocaleCode = lang ?? (i18n.language === "en" ? "en" : "pt-BR");
  const t = usePageT(locale);
  const doc = isHelpSlug(slug) ? helpDocument(slug, locale) : null;
  useDocumentTitle(doc ? `${doc.title} · agentes.chat` : undefined);
  if (!doc) return <Navigate to="/" replace />;

  const switchTo = (code: LocaleCode) => {
    setLocale(code, i18n);
    void navigate({ to: "/help/$slug", params: { slug }, search: { lang: code }, replace: true });
  };
  return (
    <div className="lp lp-help" data-theme={theme} ref={root} lang={locale}>
      <header className="lp-nav">
        <Link className="lp-logo" to="/">
          <Logo variant="expanded" size={21} />
        </Link>
        <Segmented
          size="sm"
          className="lp-lang"
          label={t("landing.nav.language")}
          value={locale}
          options={[
            { value: "pt-BR" as const, label: t("landing.nav.langPt") },
            { value: "en" as const, label: t("landing.nav.langEn") },
          ]}
          onValueChange={switchTo}
        />
        <Button variant="ghost" className="lp-theme-btn" aria-label={t("landing.nav.theme")} onClick={toggleTheme}>
          <LpIcon name={theme === "light" ? "moon" : "sun"} />
        </Button>
      </header>
      <main className="lp-help__main">
        <article className="lp-help__doc">
          <h1>{doc.title}</h1>
          <p className="lp-help__summary">{doc.summary}</p>
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
      </main>
      <Footer t={t} />
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
      <pre>
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
