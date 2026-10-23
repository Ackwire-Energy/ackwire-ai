import { type LegalBlock, type LegalKind, legalDocument, legalInline } from "@agenteschat/i18n/legal";
import { Logo, Segmented } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { Fragment, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { type LocaleCode, locales, setLocale } from "@/i18n";
import "./legal.css";

/**
 * Terms of Use and Privacy Policy (`/terms`, `/privacy`): public pages in the
 * reader's language, the same text as the landing page's (`@agenteschat/i18n/legal`).
 */
export function LegalPage({ kind }: { kind: LegalKind }) {
  const { t, i18n } = useTranslation();
  const doc = legalDocument(kind, i18n.language);
  const other = legalDocument(kind === "terms" ? "privacy" : "terms", i18n.language);
  const updated = new Intl.DateTimeFormat(i18n.language, { dateStyle: "long", timeZone: "UTC" }).format(
    new Date(`${doc.updated}T00:00:00Z`),
  );

  useEffect(() => {
    document.title = `${doc.title} · agentes.chat`;
  }, [doc.title]);

  return (
    <div className="legal">
      <header className="legal__bar">
        <Link to="/" aria-label={t("legal.home")}>
          <Logo size={24} />
        </Link>
        <Segmented
          size="sm"
          label={t("shell.language")}
          value={i18n.language}
          onValueChange={(v) => setLocale(v as LocaleCode, i18n)}
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
