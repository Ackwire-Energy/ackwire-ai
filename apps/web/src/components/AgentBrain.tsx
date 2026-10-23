import type { Agent, BrainKind, BrainOption } from "@agenteschat/client";
import { type EngineKind, engineOfBrain } from "@agenteschat/client/lib/brain";
import { isAuto } from "@agenteschat/client/lib/providers";
import { Button, Dialog, DialogFooter, type IconName } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

/** Each brain's line icon (telas/IconesMotor.html): the agent itself for the API. */
const BRAIN_ICON: Record<BrainKind, IconName> = {
  model: "brainAgent",
  claude_code: "brainClaudeCode",
  codex: "brainCodex",
};

/**
 * What thinks for an agent, wherever its model is shown (DM header, profile,
 * cards): "Claude Code · Sonnet no mac", "Codex · GPT-6 Sol", or the API
 * model's label, with the matching mark (`icon` for chips, `kind` for `BrainIcon`).
 */
export function agentBrainLine(
  t: TFunction,
  agent: Pick<Agent, "brain">,
  apiModelLabel: string,
): { text: string; icon: IconName; kind: EngineKind } {
  const b = agent.brain;
  if (!b || b.kind === "model") return { text: apiModelLabel, icon: BRAIN_ICON.model, kind: "agent" };
  const model = isAuto(b.model) ? t("brain.auto.label") : (b.model ?? "");
  const text = b.computer
    ? t(`brain.line.${b.kind}`, { model, computer: b.computer })
    : t(`brain.line.${b.kind}NoComputer`, { model });
  return { text, icon: BRAIN_ICON[b.kind], kind: engineOfBrain(b.kind) };
}

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
