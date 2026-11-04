import type { ToolOutput } from "../tools/types";

/**
 * Why the Vault refused an agent (ADR 0139). The message is English, for the model, and says what to do next. It
 * never says that an item the run may not see exists: an item hidden from the person behind the run (or from a run
 * nobody is behind) is `not_found`, the same as one that never existed.
 */
export type VaultRefusalCode =
  | "not_found"
  | "not_shared"
  | "wrong_site"
  | "missing"
  | "no_value"
  | "source_error"
  | "no_person"
  | "not_allowed";

export class VaultRefusal extends Error {
  constructor(
    readonly code: VaultRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "VaultRefusal";
  }
}

const NOT_FOUND =
  "No Vault item like that is shared with you. Look with vault_list, or ask the person to save it in Settings, Vault.";

export const refuse = {
  notFound: (message = NOT_FOUND) => new VaultRefusal("not_found", message),
  notShared: (title: string) =>
    new VaultRefusal(
      "not_shared",
      `"${title}" is in the Vault but not shared with you. Someone who manages it can add you in Settings, Vault.`,
    ),
  wrongSite: (label: string, host: string) =>
    new VaultRefusal("wrong_site", `This login is for ${label}. The page is on ${host}, so it isn't typed there.`),
  noWebsite: () =>
    new VaultRefusal("wrong_site", "This login has no HTTPS website saved, so it can't be typed anywhere."),
  missing: (title: string, source: string) =>
    new VaultRefusal(
      "missing",
      `"${title}" is gone from ${source} since the last sync. Ask the person to put it back, or use another one.`,
    ),
  noValue: (title: string) =>
    new VaultRefusal("no_value", `"${title}" has nothing saved to use. Ask the person to add it in Settings, Vault.`),
  sourceError: (source: string, reason: string) =>
    new VaultRefusal("source_error", `Couldn't read it from ${source}: ${reason}`),
  noPerson: () =>
    new VaultRefusal(
      "no_person",
      "Nobody is behind this run, so there is no one to save it for. Do it when a person asks.",
    ),
  notAllowed: (why: string) => new VaultRefusal("not_allowed", why),
};

/**
 * A Vault refusal as a tool's answer, in its own words (which never say an item hidden from the run exists) with its
 * code (`vault.<code>`); null for any other error, which the tool answers its own way.
 */
export function vaultRefusalOutput(error: unknown): ToolOutput | null {
  if (!(error instanceof VaultRefusal)) return null;
  return { content: error.message, isError: true, data: { code: `vault.${error.code}` } };
}
