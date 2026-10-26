import { legalDocument } from "@agenteschat/i18n/legal";
import { Logo } from "@agenteschat/ui";
import type { TFunction } from "i18next";

/** The landing's footer, also under the help pages; `t` in the page's language. */
export function Footer({ t }: { t: TFunction }) {
  return (
    <footer className="lp-footer">
      <div className="lp-wrap">
        <Logo variant="expanded" size={18} />
        <span>{t("landing.footer")}</span>
        {/* The legal pages open in English (the reader can switch on the page). */}
        <nav className="lp-footer__legal">
          <a href="/terms">{legalDocument("terms", "en").title}</a>
          <a href="/privacy">{legalDocument("privacy", "en").title}</a>
          <a
            href="https://x.com/agentes_chat"
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t("landing.footerX")}
            title={t("landing.footerX")}
          >
            𝕏
          </a>
        </nav>
        <p className="lp-footer__company">{t("landing.footerCompany")}</p>
      </div>
    </footer>
  );
}
