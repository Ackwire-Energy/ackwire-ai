import { Button } from "@agenteschat/ui";
import { createContext, type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

/**
 * The computer dialog's one head: whichever surface shows (the screen, the page, a cover) puts its sub-line and
 * actions there, so the screen's and the page's own heads fold into the dialog's.
 */
export interface DialogHeadSlots {
  sub: HTMLElement | null;
  actions: HTMLElement | null;
  full: boolean;
  setFull: (full: boolean) => void;
  /** What the sub-line says while live and watching (the dialog knows of requests, holds and pauses). */
  watching: string;
}

export const DialogHeadContext = createContext<DialogHeadSlots | null>(null);

/** Inside the computer dialog: its head's slots. Null elsewhere (the chat's cards keep their own heads). */
export const useDialogHead = () => useContext(DialogHeadContext);

/** Puts a sub-line and actions in the dialog's head. */
export function DialogHead({ sub, actions }: { sub?: ReactNode; actions?: ReactNode }) {
  const head = useDialogHead();
  if (!head) return null;
  return (
    <>
      {head.sub && sub !== undefined && createPortal(sub, head.sub)}
      {head.actions && actions !== undefined && createPortal(actions, head.actions)}
    </>
  );
}

/** Full screen: the agent's screen alone, or the whole dialog over its page or a cover. */
export function FullButton() {
  const { t } = useTranslation();
  const head = useDialogHead();
  if (!head) return null;
  const label = head.full ? t("browser.inCard.fullExit") : t("browser.inCard.full");
  return (
    <Button
      size="sm"
      variant="ghost"
      iconOnly
      icon="external"
      aria-pressed={head.full}
      aria-label={label}
      title={label}
      onClick={() => head.setFull(!head.full)}
    />
  );
}
