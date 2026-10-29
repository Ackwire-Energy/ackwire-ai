import type { BrainOption } from "@agenteschat/client";

/** The model's label for a brain ("Opus"), or the value as typed. */
export function brainModelLabel(option: BrainOption | undefined, model: string | null) {
  const value = model ?? option?.defaultModel ?? null;
  if (!value) return "";
  return option?.models.find((m) => m.value === value)?.label ?? value;
}
