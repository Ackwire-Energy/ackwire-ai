import {
  AGENT_ACCESSORIES,
  AGENT_COLORS,
  AGENT_EYES,
  type AgentAccessory,
  type AgentAppearance,
  type AgentColor,
  type AgentEyes,
  type AgentState,
  Button,
  normalizeAppearance,
  randomAppearance,
  Segmented,
} from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUpdateAgent } from "@/api/queries";
import type { Agent } from "@/api/types";
import { AgentAvatar } from "@/components/AgentAvatar";
import { EditDialog } from "@/components/EditDialog";
import { useOrg } from "@/components/org-context";
import { agentGrammar } from "@/lib/grammar";
import { lookOf } from "@/lib/look";
import { useToast } from "@/lib/toast";

const full = (a: AgentAppearance): Required<AgentAppearance> => ({
  color: a.color ?? "sky",
  eyes: a.eyes ?? "round",
  accessory: a.accessory ?? "none",
});
const same = (a: AgentAppearance, b: AgentAppearance) => JSON.stringify(full(a)) === JSON.stringify(full(b));

/** A row of choices, each a small live symbol; radio semantics. */
function Choices<V extends string>({
  label,
  values,
  value,
  onChange,
  render,
  name,
}: {
  label: string;
  values: readonly V[];
  value: V;
  onChange: (v: V) => void;
  render: (v: V) => AgentAppearance;
  name: (v: V) => string;
}) {
  return (
    <fieldset className="look-choices">
      <legend className="ac-field__label">{label}</legend>
      <div className="look-choices__row" role="radiogroup" aria-label={label}>
        {values.map((v) => (
          // biome-ignore lint/a11y/useSemanticElements: custom radio cards with live previews, not native radios
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={v === value}
            aria-label={name(v)}
            className="look-choice"
            onClick={() => onChange(v)}
          >
            <AgentAvatar size="md" name={name(v)} appearance={render(v)} />
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * "Aparência": a big live preview of the symbol, colors, eyes and an
 * accessory, plus "Aleatório". Saves `appearance` on the agent.
 */
export function AgentCustomizer({ agent, open, onClose }: { agent: Agent; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const update = useUpdateAgent(org.id, agent.id);
  const saved = lookOf(agent) ?? {};
  const [look, setLook] = useState<Required<AgentAppearance>>(full(saved));
  const [preview, setPreview] = useState<AgentState>("idle");
  // biome-ignore lint/correctness/useExhaustiveDependencies: back to the saved look each time it opens
  useEffect(() => {
    if (open) {
      setLook(full(saved));
      setPreview("idle");
    }
  }, [open]);
  const g = agentGrammar(t, agent.name);
  const set = (patch: Partial<AgentAppearance>) => setLook((l) => full({ ...l, ...patch }));
  return (
    <EditDialog
      open={open}
      onClose={onClose}
      title={t("look.title", g)}
      description={t("look.help")}
      dirty={!same(look, saved)}
      saving={update.isPending}
      width={600}
      onSave={() =>
        update.mutate(
          { appearance: normalizeAppearance(look) },
          {
            onSuccess: () => {
              toast.show(t("look.saved", g));
              onClose();
            },
          },
        )
      }
    >
      <div className="look-stage">
        <AgentAvatar size="xl" name={agent.name} state={preview} appearance={look} labelled />
        <Segmented
          size="sm"
          label={t("look.previewState")}
          value={preview}
          onValueChange={setPreview}
          options={(["idle", "thinking", "writing"] as const).map((s) => ({ value: s, label: t(`look.state.${s}`) }))}
        />
        <Button size="sm" icon="routines" onClick={() => setLook(full(randomAppearance(look)))}>
          {t("look.random")}
        </Button>
      </div>
      <Choices<AgentColor>
        label={t("look.color")}
        values={AGENT_COLORS}
        value={look.color}
        onChange={(color) => set({ color })}
        render={(color) => ({ ...look, color, accessory: "none" })}
        name={(c) => t(`look.colors.${c}`)}
      />
      <Choices<AgentEyes>
        label={t("look.eyes")}
        values={AGENT_EYES}
        value={look.eyes}
        onChange={(eyes) => set({ eyes })}
        render={(eyes) => ({ ...look, eyes, accessory: "none" })}
        name={(e) => t(`look.eyesNames.${e}`)}
      />
      <Choices<AgentAccessory>
        label={t("look.accessory")}
        values={AGENT_ACCESSORIES}
        value={look.accessory}
        onChange={(accessory) => set({ accessory })}
        render={(accessory) => ({ ...look, accessory })}
        name={(a) => t(`look.accessories.${a}`)}
      />
    </EditDialog>
  );
}
