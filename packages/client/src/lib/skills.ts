import type { TFunction } from "i18next";
import { ApiError } from "../api/http";
import type { GitHubRepositories, Skill, SkillChoice, SkillSkipped, SkillVia } from "../api/types";
import { errorText } from "./errors";

/**
 * What a GitHub link holds when `skills.import` answers with skills to pick from, else null. `via`: which of the
 * workspace's GitHub connections read it (null: none was needed).
 */
export const skillPickOf = (
  result: unknown,
): { choices: SkillChoice[]; skipped: SkillSkipped[]; via: SkillVia | null } | null =>
  typeof result === "object" && result !== null && "choices" in result && Array.isArray(result.choices)
    ? {
        choices: result.choices,
        skipped: "skipped" in result && Array.isArray(result.skipped) ? result.skipped : [],
        via: "via" in result && (result.via === "github_app" || result.via === "github") ? result.via : null,
      }
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

/** A repository's link on GitHub, as the import reads it. */
export const githubRepoLink = (fullName: string) => `https://github.com/${fullName}`;

const ownerOf = (url: string) => /^https:\/\/github\.com\/([^/?#]+)/.exec(url.trim())?.[1] ?? "";

/** "Lido pelo app do GitHub em acme.": which of the workspace's GitHub connections read a private link. */
export const skillViaText = (t: TFunction, via: SkillVia, url: string) =>
  t(`skills.via.${via}`, { owner: ownerOf(url) });

/**
 * "Do repositório privado, pelo app do GitHub em acme.": the line of a skill still from its link; null when no
 * connection read it, or once edited or replaced by an upload (the server keeps how to update it all the same).
 */
export const skillSourceViaText = (t: TFunction, skill: Pick<Skill, "source" | "sourceVia" | "sourceUrl">) =>
  skill.source === "url" && skill.sourceVia
    ? t(`skills.sourceVia.${skill.sourceVia}`, { owner: ownerOf(skill.sourceUrl ?? "") })
    : null;

/**
 * A link none of the workspace's GitHub reads (`github.repo_missing`): its GitHub connection (`none`, `refused` when
 * GitHub no longer takes its token, `ok` when it works and can't see the repository) and whether the GitHub App is
 * installed on some account (`app`). An older server says neither: none.
 */
export interface HiddenRepo {
  repo: string;
  connection: "none" | "refused" | "ok";
  app: boolean;
}

export function hiddenRepoOf(error: unknown): HiddenRepo | null {
  if (!(error instanceof ApiError) || error.code !== "github.repo_missing") return null;
  const connection = error.params?.connection;
  return {
    repo: String(error.params?.repo ?? ""),
    connection: connection === "refused" || connection === "ok" ? connection : "none",
    app: error.params?.app === true,
  };
}

/**
 * What to say of a link none of the workspace's GitHub reads, and whether to offer "Conectar o GitHub": whenever no
 * connection works (none, or one GitHub refuses) and the person may connect it. A connection that works but can't
 * see the repository is given access on GitHub, never replaced from here (every agent uses its token).
 */
export function hiddenRepoText(t: TFunction, hidden: HiddenRepo, mayConnect: boolean) {
  const owner = hidden.repo.split("/")[0] ?? "";
  const next = !mayConnect
    ? t(hidden.connection === "ok" ? "skills.hidden.askAccess" : "skills.hidden.ask")
    : hidden.connection === "ok"
      ? t("skills.hidden.unreached")
      : hidden.connection === "refused"
        ? t("skills.hidden.refused")
        : hidden.app
          ? t("skills.hidden.app", { owner })
          : t("skills.hidden.connect");
  return {
    text: `${t("skills.hidden.lead", { repo: hidden.repo })} ${next}`,
    connect: mayConnect && hidden.connection !== "ok",
  };
}

/** Why updating a skill from its link failed, in the person's words (a hidden repository as `hiddenRepoText`). */
export function skillRefusalText(t: TFunction, error: unknown, mayConnect: boolean) {
  const hidden = hiddenRepoOf(error);
  return hidden ? hiddenRepoText(t, hidden, mayConnect).text : errorText(t, error);
}

/** The repositories the workspace's GitHub reaches whose name has the query, by account (those left with none out). */
export function searchRepos(listing: GitHubRepositories | undefined, query: string) {
  const q = query.trim().toLowerCase();
  return (listing?.accounts ?? [])
    .map((a) => ({ ...a, repositories: a.repositories.filter((r) => !q || r.fullName.toLowerCase().includes(q)) }))
    .filter((a) => a.repositories.length > 0);
}

/** Why a skill's last update from its link failed (`updateError`), in the reader's words. */
export function skillUpdateErrorText(t: TFunction, code: string) {
  const key = code.replace(/^skill\./, "");
  if (key === "no_skill_md" || key === "connection_gone" || key === "link_holds_several" || key === "link_renamed")
    return t(`skills.updateFailed.${key}`);
  if (key === "auto_update_owner_gone" || code === "forbidden") return t("skills.updateFailed.owner_gone");
  return t("skills.updateFailed.other");
}
