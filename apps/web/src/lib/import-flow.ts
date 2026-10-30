import type { ApiClient, ImportItemResult, ImportSkipReason, MigrationBundle } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { IMPORT_SOURCES, ImportError, type ImportSource, type PickedFile, SOURCE_NAME } from "@/lib/import";
import { filesFromDrop } from "@/lib/obsidian";

/**
 * The import screen around the server's plan (ADR 0055): where a bundle came
 * from, what can be picked, what a picked item needs that was unchecked, and
 * the apply in chunks the server takes. Pure, except `applyInChunks` and
 * `droppedFiles`.
 */

/** Items one apply may create or update (`IMPORT_LIMITS.perApply` in packages/engine/src/imports.ts). */
export const PER_APPLY = 200;

/** Apps that answer `EXPORT_PROMPT`: the brand, and the `source.app` the prompt suggests it writes. */
export const EXPORT_PROMPT_APPS = [
  { name: "Grok Bot", app: "grok-bot" },
  { name: "ChatGPT dots", app: "chatgpt-dots" },
  { name: "Claude", app: "claude" },
  { name: "Manus", app: "manus" },
  { name: "Rakazo", app: "rakazo" },
] as const;
type PromptApp = (typeof EXPORT_PROMPT_APPS)[number]["app"];

/**
 * The source cards, the most used apps first, then our own export and any other app. Grok Bot and
 * ChatGPT dots answer `EXPORT_PROMPT` on cards of their own. OpenBot has no card: its files are still
 * read, and land on any other app's.
 */
export const IMPORT_CARDS = [
  "grok-bot",
  "chatgpt-dots",
  "openbotrun",
  "openmausbot",
  "hermes",
  "openclaw",
  "paperclip",
  "agenteschat",
  "other",
] as const satisfies readonly (PromptApp | ImportSource | "other")[];
export type ImportCard = (typeof IMPORT_CARDS)[number];
/** The cards that show the export request to copy. */
export type RequestCard = Extract<ImportCard, PromptApp | "other">;

/** An app's own card, else any other app's. */
const cardOf = (app: string): ImportCard => IMPORT_CARDS.find((c) => c === app) ?? "other";

/**
 * Each card's tile: the app's official mark (apps/web/public/brands/README.md), and the maker's own dark
 * coloring where the mark would vanish on a dark theme.
 */
export const CARD_MARK: Record<Exclude<ImportCard, "other">, { icon: string; dark?: string }> = {
  "grok-bot": { icon: "/brands/grok-bot.svg", dark: "/brands/grok-bot-dark.svg" },
  "chatgpt-dots": { icon: "/brands/chatgpt-dots.svg" },
  openbotrun: { icon: "/brands/openbotrun.svg" },
  openmausbot: { icon: "/brands/openmausbot.svg" },
  hermes: { icon: "/brands/hermes.svg", dark: "/brands/hermes-dark.svg" },
  openclaw: { icon: "/brands/openclaw.svg" },
  paperclip: { icon: "/brands/paperclip.svg", dark: "/brands/paperclip-dark.svg" },
  agenteschat: { icon: "/favicon.svg" },
};

/**
 * The card and app name of a bundle. One in our format names its app in
 * `source.ref` ("agenteschat:<org>" for our own export, "grok-bot:…" for a
 * reply to `EXPORT_PROMPT`); `app` is null for an app we don't know.
 */
export function bundleOrigin(bundle: MigrationBundle): { card: ImportCard; app: string | null } {
  const source = IMPORT_SOURCES.find((s) => s === bundle.source.app);
  if (!source) return { card: "other", app: null };
  if (source !== "agenteschat" || bundle.source.ref.startsWith("agenteschat:")) {
    return { card: cardOf(source), app: SOURCE_NAME[source] };
  }
  const declared = EXPORT_PROMPT_APPS.find((a) => a.app === bundle.source.ref.split(":")[0]);
  return { card: declared ? cardOf(declared.app) : "other", app: declared?.name ?? null };
}

/** A link the server reads (the route's rule): https on github.com or raw.githubusercontent.com. */
export function isGithubLink(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "https:" && ["github.com", "raw.githubusercontent.com"].includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * What a GitHub link names, as a dropped folder's name does: the linked folder or file, and the
 * repository for a link to the repository itself or to one of its branches (never the branch).
 */
export function githubRoot(link: string): string | null {
  const parts = new URL(link).pathname.split("/").filter(Boolean);
  const repository = parts.length === 2 || (parts.length === 4 && (parts[2] === "tree" || parts[2] === "blob"));
  const name = repository ? parts[1] : parts.at(-1);
  return name ? decodeURIComponent(name) : null;
}

/** The cause of a pasted link to a host the server doesn't read. */
export const NOT_GITHUB = "notGithub";

/** A read that failed: the input, and the step (reading it, parsing it, or planning it on the server). */
export interface ImportFailure {
  from: "files" | "link" | "paste";
  step: "read" | "parse" | "plan";
  cause: unknown;
}

/** Trying the same input again only helps when the network or the server failed (a file is picked again instead). */
export const retryable = ({ from, step, cause }: ImportFailure) =>
  (step === "plan" || from === "link") &&
  cause !== NOT_GITHUB &&
  !(cause instanceof ImportError) &&
  !(cause instanceof ApiError && cause.status < 500);

export const itemId = (item: { kind: string; key: string }) => `${item.kind}:${item.key}`;

/** A row the person checks or unchecks: something the import would create or change. */
export const choosable = (item: ImportItemResult) => item.action === "create" || item.action === "update";

/**
 * Routines and notes that won't come although checked: the agent (or channel)
 * they need is new here, or a channel the agents would only now join, and
 * unchecked. One that an earlier import brought stays either way.
 */
export function blockedItems(
  bundle: MigrationBundle,
  items: ImportItemResult[],
  pick: ReadonlySet<string>,
): Map<string, ImportSkipReason> {
  const onlyIfPicked = new Set(
    items.filter((i) => i.action === "create" || (i.action === "update" && i.reason === "exists")).map(itemId),
  );
  const gone = (id: string) => onlyIfPicked.has(id) && !pick.has(id);
  const out = new Map<string, ImportSkipReason>();
  for (const r of bundle.routines) {
    if (gone(`agent:${r.agent}`)) out.set(`routine:${r.key}`, "agent_not_picked");
    else if (r.channel !== null && gone(`channel:${r.channel}`)) out.set(`routine:${r.key}`, "channel_not_picked");
  }
  for (const n of bundle.notes) {
    if (n.agent !== null && gone(`agent:${n.agent}`)) out.set(`note:${n.key}`, "agent_not_picked");
  }
  return out;
}

/** What to apply, in the plan's order (what an item needs comes before it). */
export function picksOf(
  items: ImportItemResult[],
  pick: ReadonlySet<string>,
  blocked: ReadonlyMap<string, ImportSkipReason>,
): string[] {
  return items.filter((i) => choosable(i) && pick.has(itemId(i)) && !blocked.has(itemId(i))).map(itemId);
}

/**
 * The bundle with only these items, and every agent: the server gives a new
 * agent its handle looking at all of them, picked or not, so the handle each
 * row showed is the one it gets. What earlier chunks made, the server already
 * knows by its provenance, so a chunk doesn't carry the whole bundle.
 */
export function sliceBundle(bundle: MigrationBundle, pick: ReadonlySet<string>): MigrationBundle {
  const has =
    (kind: string) =>
    ({ key }: { key: string }) =>
      pick.has(`${kind}:${key}`);
  return {
    ...bundle,
    skills: bundle.skills.filter(has("skill")),
    channels: bundle.channels.filter(has("channel")),
    routines: bundle.routines.filter(has("routine")),
    notes: bundle.notes.filter(has("note")),
    todo: [],
    leftOut: [],
  };
}

/**
 * Applies the picked items, `PER_APPLY` at a time in the plan's order (each
 * call is safe to repeat). `done` carries over attempts: an item an earlier
 * attempt made comes back unchanged on a retry, and still counts as made.
 */
export async function applyInChunks(
  api: ApiClient,
  orgId: string,
  input: { bundle: MigrationBundle; pick: string[]; enableSkills: string[] },
  done: Map<string, ImportItemResult>,
  onProgress?: (applied: number) => void,
): Promise<ImportItemResult[]> {
  for (let at = 0; at < input.pick.length; at += PER_APPLY) {
    const pick = input.pick.slice(at, at + PER_APPLY);
    const { items } = await api.imports.apply(orgId, {
      bundle: sliceBundle(input.bundle, new Set(pick)),
      dryRun: false,
      pick,
      enableSkills: input.enableSkills,
    });
    for (const item of items) {
      const before = done.get(itemId(item));
      if (!(before && before.action !== "skip" && item.action === "unchanged")) done.set(itemId(item), item);
    }
    onProgress?.(Math.min(at + PER_APPLY, input.pick.length));
  }
  return input.pick.flatMap((id) => done.get(id) ?? []);
}

/** A drop as the import reads it: the files, or every file in the dropped folders, with its path. */
export async function droppedFiles(dt: DataTransfer): Promise<PickedFile[]> {
  // The entries are only readable during the drop event: both reads below start before any await.
  const folders = Array.from(dt.items ?? []).some((i) => i.webkitGetAsEntry?.()?.isDirectory);
  if (!folders) return Array.from(dt.files);
  const files = await filesFromDrop(dt);
  return Promise.all(files.map(async (f) => ({ path: f.path, file: await f.blob() })));
}
