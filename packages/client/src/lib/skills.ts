import type { SkillChoice } from "../api/types";

/** The skills a GitHub link holds when `skills.import` answers with several to pick from, else null. */
export const skillChoicesOf = (result: unknown): SkillChoice[] | null =>
  typeof result === "object" && result !== null && "choices" in result && Array.isArray(result.choices)
    ? result.choices
    : null;

/** The picked skills' paths after checking (`on`) or unchecking these. */
export function pickSkills(picked: ReadonlySet<string>, paths: string[], on: boolean): Set<string> {
  const next = new Set(picked);
  for (const path of paths) {
    if (on) next.add(path);
    else next.delete(path);
  }
  return next;
}
