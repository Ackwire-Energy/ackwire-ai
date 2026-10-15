import { Icon } from "@agenteschat/ui";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

const QUESTIONS = [1, 2, 3, 4, 5] as const;

/** "Perguntas": an accordion; any number of answers can be open. */
export function Faq() {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const toggle = (n: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  return (
    <section className="lp-sec lp-sec--flush" id="perguntas">
      <div className="lp-wrap lp-faq-grid">
        <div className="lp-sec-head lp-sec-head--flush">
          <span className="lp-eyebrow">{t("landing.faq.eyebrow")}</span>
          <h2>{t("landing.faq.title")}</h2>
        </div>
        <div className="lp-faq">
          {QUESTIONS.map((n) => {
            const isOpen = open.has(n);
            return (
              <div className="lp-qa" data-open={isOpen} key={n}>
                <button type="button" aria-expanded={isOpen} aria-controls={`${id}-${n}`} onClick={() => toggle(n)}>
                  {t(`landing.faq.q${n}`)}
                  <Icon name="plus" />
                </button>
                <div className="lp-a" id={`${id}-${n}`} hidden={!isOpen}>
                  <p>{t(`landing.faq.a${n}`)}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
