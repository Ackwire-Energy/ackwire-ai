import { type LegalBlock, type LegalKind, legalDocument, legalInline } from "@agenteschat/i18n/legal";
import { Logo, Segmented } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { Fragment, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type LocaleCode, loadLocale, locales } from "@/i18n";
import "./legal.css";

/**
 * Terms of Use and Privacy Policy (`/terms`, `/privacy`): public pages, the
 * same text as the landing page's (`@agenteschat/i18n/legal`). They open in
 * English wherever the reader is; the switch shows Portuguese here only.
 */
export function LegalPage({ kind }: { kind: LegalKind }) {
  const { i18n } = useTranslation();
  const [lang, setLang] = useState<LocaleCode>("en");
  // The app downloads only its own language; the page's labels wait for theirs.
  const [loaded, setLoaded] = useState<LocaleCode | null>(null);
  useEffect(() => {
    loadLocale(lang, i18n)
      .then(() => setLoaded(lang))
      .catch(() => {});
  }, [lang, i18n]);
  const t = i18n.getFixedT(loaded === lang ? lang : i18n.language);
  const doc = legalDocument(kind, lang);
  const other = legalDocument(kind === "terms" ? "privacy" : "terms", lang);
  const updated = new Intl.DateTimeFormat(lang, { dateStyle: "long", timeZone: "UTC" }).format(
    new Date(`${doc.updated}T00:00:00Z`),
  );

  useEffect(() => {
    document.title = `${doc.title} · agentes.chat`;
  }, [doc.title]);

  return (
    <div className="legal" lang={lang}>
      <header className="legal__bar">
        <Link to="/" aria-label={t("legal.home")}>
          <Logo size={24} />
        </Link>
        <Segmented
          size="sm"
          label={t("shell.language")}
          value={lang}
          onValueChange={(v) => setLang(v as LocaleCode)}
          options={locales.map((l) => ({ value: l.code, label: l.label }))}
        />
      </header>
      <main className="page page--narrow">
        <header className="legal__head">
          <h1 className="page-title">{doc.title}</h1>
          <p className="page-sub">{doc.summary}</p>
          <p className="legal__date">{t("legal.updated", { date: updated })}</p>
        </header>
        <nav className="legal__toc" aria-label={t("legal.contents")}>
          <ol>
            {doc.sections.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`}>{s.heading}</a>
              </li>
            ))}
          </ol>
        </nav>
        <article className="md legal__doc">
          {doc.sections.map((s) => (
            <Fragment key={s.id}>
              <h2 id={s.id}>{s.heading}</h2>
              {s.blocks.map((b, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the text is fixed, its order never changes
                <Block key={i} block={b} />
              ))}
            </Fragment>
          ))}
        </article>
        <footer className="legal__foot">
          <Link to={kind === "terms" ? "/privacy" : "/terms"}>{other.title}</Link>
        </footer>
      </main>
    </div>
  );
}

function Block({ block }: { block: LegalBlock }) {
  if (typeof block === "string") return <Inline line={block} />;
  return (
    <ul>
      {block.list.map((item) => (
        <li key={item}>
          <Inline line={item} bare />
        </li>
      ))}
    </ul>
  );
}

function Inline({ line, bare }: { line: string; bare?: boolean }) {
  const parts = legalInline(line).map((p, i) =>
    p.kind === "bold" ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: pieces of one fixed line
      <strong key={i}>{p.text}</strong>
    ) : p.kind === "link" ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: pieces of one fixed line
      <a key={i} href={p.href}>
        {p.text}
      </a>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: pieces of one fixed line
      <Fragment key={i}>{p.text}</Fragment>
    ),
  );
  return bare ? <>{parts}</> : <p>{parts}</p>;
}
