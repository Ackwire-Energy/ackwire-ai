import { tooLongText } from "@agenteschat/client/lib/message-length";
import { Icon } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";

/**
 * In the composer (`notice`), over a draft past the length limit: its size and the limit, then the way out. Without
 * `onAsFile` (nothing more can be attached here) the words say it.
 */
export function LongDraftNotice({ length, onAsFile }: { length: number; onAsFile?: () => void }) {
  const { t, i18n } = useTranslation();
  const text = tooLongText(t, i18n.language, length);
  return (
    <>
      <span className="ac-iconline">
        <Icon name="alert" size={16} />
        <span>{onAsFile ? text : `${text} ${t("channel.tooLong.fix")}`}</span>
      </span>
      {onAsFile && (
        <button type="button" className="ac-link" onClick={onAsFile}>
          {t("channel.tooLong.asFile")}
        </button>
      )}
    </>
  );
}
