import { foldsText } from "@agenteschat/client/lib/text";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageBody } from "@/chat/MessageBody";

/** A long text an agent wrote, on a page rather than in a conversation: its Markdown as a message's, folded until asked. */
export function FoldedBody({ body }: { body: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const long = foldsText(body);
  return (
    <div className="folded-body">
      <div className="folded-body__text" data-folded={long && !open ? "" : undefined}>
        <MessageBody body={body} />
      </div>
      {long && (
        <button type="button" className="ac-link folded-body__more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {t(open ? "folded.less" : "folded.more")}
        </button>
      )}
    </div>
  );
}
