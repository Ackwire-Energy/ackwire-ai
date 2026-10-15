import { Button, Dialog, DialogBody, DialogFooter } from "@agenteschat/ui";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * A dialog that edits something and saves explicitly: "Salvar" only when
 * there are changes, "Alterações não salvas" in the footer, and closing with
 * changes (Esc, the close button, "Cancelar") asks before discarding.
 */
export function EditDialog({
  open,
  onClose,
  title,
  description,
  dirty,
  saving,
  onSave,
  saveLabel,
  width,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  dirty: boolean;
  saving?: boolean;
  onSave: () => void;
  saveLabel?: string;
  width?: number;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!open) setConfirm(false);
  }, [open]);
  const tryClose = () => (dirty ? setConfirm(true) : onClose());
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) tryClose();
      }}
      title={title}
      description={description}
      closeLabel={t("common.close")}
      width={width}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty && !saving) onSave();
        }}
      >
        <DialogBody>{children}</DialogBody>
        {confirm ? (
          <DialogFooter note={t("edit.discardQuestion")}>
            <Button type="button" onClick={() => setConfirm(false)}>
              {t("edit.keepEditing")}
            </Button>
            <Button type="button" variant="danger" onClick={onClose}>
              {t("edit.discard")}
            </Button>
          </DialogFooter>
        ) : (
          <DialogFooter note={dirty ? t("edit.unsaved") : undefined}>
            <Button type="button" onClick={tryClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={!dirty || saving}>
              {saveLabel ?? t("common.save")}
            </Button>
          </DialogFooter>
        )}
      </form>
    </Dialog>
  );
}
