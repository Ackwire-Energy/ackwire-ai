import type { TFunction } from "i18next";
import { joinNames } from "./format";

/** Who something is for (ADR 0150): "only me" is a list of one, and administrators always see it. */
export type AudienceChoice = { mode: "everyone" } | { mode: "people"; userIds: string[] };
export type AudienceKind = "everyone" | "me" | "people";

export const EVERYONE: AudienceChoice = { mode: "everyone" };

/** Which of the three options `a` is, for `myId`. */
export function audienceKind(a: { mode: "everyone" | "people"; userIds?: readonly string[] }, myId: string) {
  if (a.mode === "everyone") return "everyone" satisfies AudienceKind;
  const ids = a.userIds ?? [];
  return ids.length === 1 && ids[0] === myId ? ("me" satisfies AudienceKind) : ("people" satisfies AudienceKind);
}

/** What the option `kind` saves; "only me" and a list always hold me, unless I'm an administrator and left myself out. */
export function audienceOfKind(kind: AudienceKind, userIds: readonly string[], myId: string): AudienceChoice {
  if (kind === "everyone") return EVERYONE;
  return { mode: "people", userIds: kind === "me" ? [myId] : [...userIds] };
}

/** The setting in a few words: "Todos no workspace", "Só eu", "Só Ana", "Ana e Bia", "Ana, Bia e mais 2". */
export function whoSeesLabel(
  t: TFunction,
  a: { mode: "everyone" | "people"; userIds?: readonly string[] },
  myId: string,
  nameOf: (id: string) => string | undefined,
) {
  const kind = audienceKind(a, myId);
  if (kind === "everyone") return t("whoSees.everyone");
  if (kind === "me") return t("whoSees.me");
  const names = (a.userIds ?? []).flatMap((id) => {
    const name = nameOf(id);
    return name ? [name] : [];
  });
  const [first] = names;
  if (first === undefined) return t("whoSees.people");
  if (names.length === 1) return t("whoSees.only", { name: first });
  if (names.length <= 3) return joinNames(names, t);
  return t("whoSees.more", { names: names.slice(0, 2).join(", "), count: names.length - 2 });
}
