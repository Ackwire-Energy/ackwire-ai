import { useAuthConfig } from "@agenteschat/client";
import { Card, Icon } from "@agenteschat/ui";
import { useId, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import "./faq.css";

/** The questions, in the order they appear (`landing.faq.items.<key>`). */
const QUESTIONS = ["opens", "code", "models", "alone", "where", "data", "tools", "price"] as const;
type Question = (typeof QUESTIONS)[number];

/**
 * "Perguntas": two columns of cards; any number of answers can be open. The price answer links the billing
 * service's price page in the page's language, and without a billing service there is no price to ask about.
 */
export function Faq() {
  const { t, i18n } = useTranslation();
  const billingUrl = useAuthConfig().data?.billingUrl;
  const prices = billingUrl
    ? `${billingUrl.replace(/\/+$/, "")}/${i18n.language.startsWith("en") ? "pricing" : "precos"}`
    : null;
  const id = useId();
  const [open, setOpen] = useState<ReadonlySet<Question>>(new Set());
  const toggle = (q: Question) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(q)) next.delete(q);
      else next.add(q);
      return next;
    });
  return (
    <section className="lp-sec" id="perguntas">
      <div className="lp-wrap">
        <div className="lp-sec-head">
          <span className="lp-eyebrow">{t("landing.faq.eyebrow")}</span>
          <h2>{t("landing.faq.title")}</h2>
        </div>
        <div className="lp-faq-list">
          {QUESTIONS.filter((q) => q !== "price" || prices).map((q) => {
            const isOpen = open.has(q);
            return (
              <Card as="div" className="lp-faq-item" data-open={isOpen} key={q}>
                <h3 className="lp-faq-h">
                  <button
                    type="button"
                    className="lp-faq-q"
                    aria-expanded={isOpen}
                    aria-controls={`${id}-${q}`}
                    onClick={() => toggle(q)}
                  >
                    <span>{t(`landing.faq.items.${q}.q`)}</span>
                    <Icon name="plus" />
                  </button>
                </h3>
                <div className="lp-faq-a" id={`${id}-${q}`} hidden={!isOpen}>
                  <p>
                    {q === "price" && prices ? (
                      <Trans
                        i18nKey="landing.faq.items.price.a"
                        // biome-ignore lint/a11y/useAnchorContent: Trans puts the translated words inside the link
                        components={{ prices: <a href={prices} /> }}
                      />
                    ) : (
                      t(`landing.faq.items.${q}.a`)
                    )}
                  </p>
                </div>
              </Card>
            );
          })}
        </div>
      </div>
    </section>
  );
}
