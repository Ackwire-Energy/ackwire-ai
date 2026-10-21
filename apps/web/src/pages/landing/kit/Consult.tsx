import { Icon } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { CAST, type CastKey } from "../cast";
import { LpAvatar } from "../LpAvatar";

/**
 * One agent asking another in private, shown inside the asker's message:
 * "Dev perguntou ao Atlas · em particular", the question, and the answer
 * once it arrives.
 */
export function Consult({
  from,
  to,
  question,
  answer,
}: {
  from: CastKey;
  to: CastKey;
  question: string;
  answer?: string;
}) {
  const { t } = useTranslation();
  const target = CAST[to];
  return (
    <div className="lp-consult lp-enter">
      <LpAvatar look={target.look} size="xs" name={target.name} state={answer ? "idle" : "thinking"} />
      <div>
        <div className="lp-consult__lab">
          <Icon name="message" size={14} />
          {t(target.feminine ? "landing.consult.toF" : "landing.consult.toM", {
            from: CAST[from].name,
            to: target.name,
          })}
        </div>
        <div>{question}</div>
        {answer && <div className="lp-consult__a">{answer}</div>}
      </div>
    </div>
  );
}
