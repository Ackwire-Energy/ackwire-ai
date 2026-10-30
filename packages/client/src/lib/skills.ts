import type { TFunction } from "i18next";
import { ApiError } from "../api/http";
import type { SkillPick, SkillSkipped } from "../api/types";
import { errorText } from "./errors";

/** What a GitHub link holds when `skills.import` answers with several skills to pick from, else null. */
export const skillPickOf = (result: unknown): Required<SkillPick> | null =>
  typeof result === "object" && result !== null && "choices" in result && Array.isArray(result.choices)
    ? { choices: result.choices, skipped: "skipped" in result && Array.isArray(result.skipped) ? result.skipped : [] }
    : null;

/** Why a skill a link holds can't be installed, in the person's words when the server's code is known. */
export const skippedSkillText = (t: TFunction, skipped: SkillSkipped) =>
  t("skills.pickSkipped", { reason: errorText(t, new ApiError(400, skipped.code, skipped.message, skipped.params)) });

/** The picked skills' paths after checking (`on`) or unchecking these. */
export function pickSkills(picked: ReadonlySet<string>, paths: string[], on: boolean): Set<string> {
  const next = new Set(picked);
  for (const path of paths) {
    if (on) next.add(path);
    else next.delete(path);
  }
  return next;
}
