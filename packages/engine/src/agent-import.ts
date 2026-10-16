import type { Database } from "@agenteschat/db";
import { ValidationError } from "./errors";
import { requirePermission } from "./organizations";
import { fetchGithub, type GithubFetchDeps, parseGithubUrl } from "./skills";

/**
 * Bringing agents from another app (onboarding "Trazer seus agentes"): the
 * web app parses the files (an OpenMausBot team file, an OpenBot package);
 * the backend only reads them from GitHub for a link, because the browser
 * shouldn't call third parties. Only GitHub hosts, the SSRF guard on every
 * request, no redirects, and these limits (an OpenMausBot package is at most
 * 4 MB).
 */
export const AGENT_IMPORT_LIMITS = { maxFiles: 40, maxBytes: 4 * 1024 * 1024 };
/** Team files and agent definitions: Markdown, JSON or YAML. */
const IMPORT_FILE = /\.(md|markdown|json|ya?ml)$/i;
/** An OpenBot package keeps one coworker per file in this folder (docs/configuration.md). */
const AGENTS_DIR = "agents";

export interface AgentImportDeps extends GithubFetchDeps {
  db: Database;
}

export interface ImportedFile {
  /** Relative to the linked folder (or the file's own name). */
  path: string;
  text: string;
}

const TOO_LARGE = "The files are too large (max 4 MB)";

/**
 * The text files behind a GitHub link: one file (`/blob/…` or raw), or the
 * Markdown/JSON/YAML files at the top of a folder (`/tree/…` or the repo)
 * plus its `agents/` folder. Never runs or stores anything.
 */
export async function readGithubImport(
  deps: AgentImportDeps,
  actorId: string,
  orgId: string,
  url: string,
): Promise<{ files: ImportedFile[] }> {
  await requirePermission(deps.db, actorId, orgId, "manage_agents");
  let target: ReturnType<typeof parseGithubUrl>;
  try {
    target = parseGithubUrl(url);
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError("Unrecognized GitHub URL");
  }
  const raw = (path: string) =>
    `https://raw.githubusercontent.com/${target.owner}/${target.repo}/${target.ref}/${path.split("/").map(encodeURIComponent).join("/")}`;
  let total = 0;
  const read = async (path: string) => {
    const data = await fetchGithub(deps, raw(path), "text/plain", {
      maxBytes: AGENT_IMPORT_LIMITS.maxBytes - total,
      tooLarge: TOO_LARGE,
    });
    total += data.byteLength;
    return new TextDecoder().decode(data);
  };
  if (target.kind === "file") {
    if (!IMPORT_FILE.test(target.path)) throw new ValidationError("Link a Markdown, JSON or YAML file");
    const name = target.path.split("/").pop() ?? target.path;
    return { files: [{ path: name, text: await read(target.path) }] };
  }

  const list = async (dir: string) => {
    const listing = JSON.parse(
      new TextDecoder().decode(
        await fetchGithub(
          deps,
          `https://api.github.com/repos/${target.owner}/${target.repo}/contents/${dir.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(target.ref)}`,
          "application/vnd.github+json",
          { maxBytes: 1024 * 1024, tooLarge: "The folder listing is too large" },
        ),
      ),
    ) as unknown;
    if (!Array.isArray(listing)) throw new ValidationError("That URL is not a folder");
    return listing as { type: string; path: string; size: number }[];
  };
  const base = target.path.replace(/\/+$/, "");
  const relative = (path: string) => (base ? path.slice(base.length + 1) : path);
  const files: ImportedFile[] = [];
  const take = async (items: { type: string; path: string; size: number }[]) => {
    for (const item of items) {
      if (item.type !== "file" || !IMPORT_FILE.test(item.path)) continue;
      if (files.length >= AGENT_IMPORT_LIMITS.maxFiles) throw new ValidationError("Too many files (max 40)");
      if (total + (item.size ?? 0) > AGENT_IMPORT_LIMITS.maxBytes) throw new ValidationError(TOO_LARGE);
      files.push({ path: relative(item.path), text: await read(item.path) });
    }
  };
  const top = await list(base);
  await take(top);
  const agentsDir = top.find((item) => item.type === "dir" && item.path.split("/").pop() === AGENTS_DIR);
  if (agentsDir) await take(await list(agentsDir.path));
  if (files.length === 0) throw new ValidationError("No Markdown, JSON or YAML files in that folder");
  return { files };
}
