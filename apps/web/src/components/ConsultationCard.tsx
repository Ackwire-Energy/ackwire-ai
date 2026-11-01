import type { MessageConsultation } from "@agenteschat/client";
import { consultAskedKey, consultLineKey } from "@agenteschat/client/lib/consult-group";
import { CONSULTATION_MINUTES, previewOf } from "@agenteschat/client/lib/consultations";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { cx, Icon } from "@agenteschat/ui";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageBody } from "@/chat/MessageBody";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";

/**
 * What another agent told this one before it answered (`meta.consulted`), or did with work it handed it:
 * a neutral one-line card
 * on top of the reply, "Infra respondeu" with a faded preview, that opens to
 * the question (or the work) and the full answer. Expired or failed: the same card, calm,
 * with an icon instead of the agent.
 */
export function ConsultationCard({
  consultation: c,
  askerId,
}: {
  consultation: MessageConsultation;
  /** The agent that asked (the reply's author). */
  askerId: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const to = agentGrammar(t, dir.agentById.get(c.agentId)?.name ?? t("channel.unknownAgent"));
  const from = agentGrammar(t, dir.agentById.get(askerId)?.name ?? t("channel.unknownAgent"));
  const ok = c.status === "answered" && c.answer !== null;
  const minutes = CONSULTATION_MINUTES;
  const state = ok ? "answered" : c.status === "expired" ? "expired" : "failed";
  const title = t(consultLineKey(state, { kind: c.kind, waiting: null }), { name: to.name, The: to.The });
  const preview = ok
    ? previewOf(c.answer ?? "")
    : c.status === "expired"
      ? t("chat.consultation.waited", { minutes })
      : t("chat.consultation.wentOn");
  return (
    <div className={cx("ac-consult", open && "ac-consult--open")}>
      <button
        type="button"
        className="ac-consult__head"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {ok ? (
          <AgentAvatar agentId={c.agentId} size="xs" name={to.name} state="idle" />
        ) : (
          <span className="ac-consult__ic" aria-hidden="true">
            <Icon name={c.status === "expired" ? "clock" : "info"} size={14} />
          </span>
        )}
        <b>{title}</b>
        <span className="ac-consult__pv">{preview}</span>
        <span className="ac-consult__chev" aria-hidden="true">
          <Icon name="chevronDown" size={16} />
        </span>
      </button>
      {open && (
        <div className="ac-consult__body" id={bodyId}>
          <small>{t(consultAskedKey(c), { name: from.name })}</small>
          <div className="ac-consult__text ac-consult__text--q">
            <MessageBody body={c.question} resolveMention={dir.mentionName} />
          </div>
          {ok ? (
            <>
              <small>{t("chat.consultation.answerOf", { name: to.name, of: to.of })}</small>
              <div className="ac-consult__text">
                <MessageBody body={c.answer ?? ""} resolveMention={dir.mentionName} />
              </div>
            </>
          ) : (
            <>
              <small>{t("chat.consultation.answer")}</small>
              <p className="ac-consult__text ac-consult__text--q">
                {c.status === "expired"
                  ? t("chat.consultation.noAnswer", { minutes, from: from.name, theFrom: from.The })
                  : t("chat.consultation.couldNot", {
                      from: from.name,
                      theFrom: from.The,
                      to: to.name,
                      theTo: to.The,
                    })}
              </p>
            </>
          )}
          <p className="ac-consult__foot ac-iconline">
            <Icon name="eyeOff" size={14} />
            {t("chat.consultation.private", {
              from: from.name,
              articleFrom: from.article,
              to: to.name,
              articleTo: to.article,
            })}
          </p>
        </div>
      )}
    </div>
  );
}
