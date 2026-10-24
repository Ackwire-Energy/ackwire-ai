import type { BrainOption } from "@agenteschat/client";
import { Button, Dialog, DialogFooter } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";

/** The model's label for a brain ("Opus"), or the value as typed. */
export function brainModelLabel(option: BrainOption | undefined, model: string | null) {
  const value = model ?? option?.defaultModel ?? null;
  if (!value) return "";
  return option?.models.find((m) => m.value === value)?.label ?? value;
}

/**
 * The plan warning (the subscription is personal; answering other people with
 * it may go against the provider's terms). Shown when Claude Code or Codex is
 * chosen, and again on save if a switch reached the draft unconfirmed.
 */
export function PlanTermsDialog({
  brain,
  onCancel,
  onConfirm,
}: {
  /** The brain being confirmed; null = closed. */
  brain: "claude_code" | "codex" | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={brain !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={t("brain.warning.title")}
      description={brain ? t(`brain.warning.${brain}`) : undefined}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogFooter>
        <Button onClick={onCancel}>{t("brain.warning.cancel")}</Button>
        <Button variant="primary" onClick={onConfirm}>
          {t("brain.warning.confirm")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
