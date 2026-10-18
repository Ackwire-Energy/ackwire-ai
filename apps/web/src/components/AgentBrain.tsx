import type { Agent, AgentBrain, BrainKind, BrainOption } from "@agenteschat/client";
import { type EngineKind, engineOfBrain, engineStateOfOption } from "@agenteschat/client/lib/brain";
import type { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  type AgentAppearance,
  BrainIcon,
  BrainPortrait,
  Button,
  Chip,
  Dialog,
  DialogFooter,
  Field,
  type IconName,
  OptionList,
  Select,
  SettingNote,
  SettingRow,
  Switch,
} from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { type ReactNode, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { type BrainChoice, needsPlanWarning } from "@/lib/agent-edit";

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
  const model = b.model ?? "";
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

/** "Claude Code · Opus" (and ", sem reserva pela API" when the fallback is off), for the save bar. */
export function brainSummary(t: TFunction, choice: BrainChoice, options: BrainOption[] | undefined) {
  if (choice.brain === "model") return t("brain.summary.model");
  const option = options?.find((o) => o.kind === choice.brain);
  const text = t(`brain.summary.${choice.brain}`, { model: brainModelLabel(option, choice.model) });
  return choice.fallback ? text : t("brain.summary.noFallback", { brain: text });
}

/**
 * "Quem pensa" in the agent's Configurações (ADR 0032): the model (API), or
 * Claude Code / Codex on its computer, as three cards with their portraits
 * (telas/IconesMotor.html, the agent's small self in its own look). Under the
 * cards, the chosen one's settings: the API's model and key (`apiFields`), or a
 * computer brain's model and the fallback to the API. Choosing a plan brain anew
 * asks for the warning to be confirmed first (the plan is personal); the
 * audience is never blocked.
 */
export function AgentBrainChoice({
  view,
  value,
  savedBrain,
  onChange,
  g,
  apiFields,
  look,
}: {
  view: AgentBrain;
  value: BrainChoice;
  /** What is saved (the warning shows only for a brain not saved yet). */
  savedBrain: BrainKind | undefined;
  /** Absent: read-only. */
  onChange?: (next: BrainChoice) => void;
  g: ReturnType<typeof agentGrammar>;
  /** Under "Modelo (API)" when chosen: its model and key. */
  apiFields?: ReactNode;
  /** The agent's look (the draft's), for its small self in the portraits. */
  look?: AgentAppearance;
}) {
  const { t } = useTranslation();
  const [asking, setAsking] = useState<"claude_code" | "codex" | null>(null);
  const fallbackId = useId();
  const computer = view.computer?.name ?? null;
  const editable = Boolean(onChange) && view.canEdit;

  const choose = (kind: BrainKind) => {
    if (!onChange || kind === value.brain) return;
    if (kind !== "model" && needsPlanWarning(savedBrain, kind)) {
      setAsking(kind);
      return;
    }
    onChange({ ...value, brain: kind, model: null, termsAccepted: false });
  };

  const reason = (o: BrainOption) => (o.reason ? t(`brain.reasons.${o.reason}`, { computer: computer ?? "" }) : null);

  /** Under the chosen row: why it can't run now, then its own settings. */
  const settings = (o: BrainOption) => (
    <>
      {!o.available && (
        <SettingNote icon="alert">
          {t("brain.notAvailableNow")} {reason(o)}
        </SettingNote>
      )}
      {o.kind === "model" ? (
        apiFields
      ) : (
        <>
          {o.available && view.computer && !view.computer.online && (
            <SettingNote icon="pause">{t("brain.offline", { computer })}</SettingNote>
          )}
          <Field label={t("brain.modelLabel")} id="agp-brain-model" help={t("brain.modelHelp")}>
            <Select
              value={value.model ?? o.defaultModel ?? undefined}
              disabled={!editable}
              onValueChange={(model) => onChange?.({ ...value, model: model === o.defaultModel ? null : model })}
              options={[
                ...o.models.map((m) => ({
                  value: m.value,
                  label: m.label,
                  description: m.recommended ? t("brain.recommended") : undefined,
                })),
                // A model typed elsewhere (the API takes any Codex model) stays visible.
                ...(value.model && !o.models.some((m) => m.value === value.model)
                  ? [{ value: value.model, label: value.model }]
                  : []),
              ]}
            />
          </Field>
          <SettingRow
            title={t("brain.fallback")}
            description={t("brain.fallbackHint", g)}
            htmlFor={editable ? fallbackId : undefined}
          >
            <Switch
              id={fallbackId}
              checked={value.fallback}
              disabled={!editable}
              onCheckedChange={(on) => onChange?.({ ...value, fallback: on })}
            />
          </SettingRow>
        </>
      )}
    </>
  );

  return (
    <>
      <OptionList
        aria-label={t("brain.title")}
        layout="cards"
        value={value.brain}
        disabled={!editable}
        onValueChange={choose}
        options={view.options.map((o) => {
          const state = engineStateOfOption(o, view.computer);
          const engine = engineOfBrain(o.kind);
          return {
            value: o.kind,
            leading: <BrainPortrait kind={engine} state={state} agent={look} />,
            title: o.kind === "model" ? t("brain.model") : t(`brain.card.${o.kind}`),
            tag: o.experimental ? t("brain.testing") : undefined,
            description: o.available || o.kind === value.brain ? t(`brain.${o.kind}Text`) : reason(o),
            foot: (
              <Chip icon={BRAIN_ICON[o.kind]} lead={<BrainIcon kind={engine} state={state} size={14} />}>
                {o.kind === "model"
                  ? t("brain.foot.api")
                  : !o.available
                    ? t("brain.foot.unavailable")
                    : !computer
                      ? t("brain.foot.noComputer")
                      : view.computer?.online === false
                        ? t("brain.foot.offline", { computer })
                        : computer}
              </Chip>
            ),
            disabled: !o.available && o.kind !== value.brain,
            children: o.kind === value.brain ? settings(o) : undefined,
          };
        })}
      />

      <PlanTermsDialog
        brain={asking}
        onCancel={() => setAsking(null)}
        onConfirm={() => {
          if (asking) onChange?.({ ...value, brain: asking, model: null, termsAccepted: true });
          setAsking(null);
        }}
      />
    </>
  );
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
