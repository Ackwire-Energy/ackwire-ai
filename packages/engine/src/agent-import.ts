import { ValidationError } from "./errors";
import { can, requirePermission } from "./organizations";
import {
  encodePath,
  fetchGithub,
  GithubMissingError,
  type GithubReadDeps,
  hiddenRepository,
  parseGithubUrl,
} from "./skills";
import { inflateZipEntry } from "./zip";

/**
 * Bringing agents from another app: the web app parses the files (a team
 * file, a package, an agent workspace); the backend only reads them from
 * GitHub for a link, because the browser shouldn't call third parties. Only
 * GitHub hosts, the SSRF guard on every request, no redirects, and these
 * limits (`fileBytes` is the parser's own per-file limit). A private
 * repository is read with the workspace's GitHub, whose tokens stay here.
 */
export const AGENT_IMPORT_LIMITS = { maxFiles: 200, maxBytes: 8 * 1024 * 1024, fileBytes: 4 * 1024 * 1024 };

/**
 * What a folder link reads, relative to the folder, in this order when the
 * limits cut: its own Markdown/JSON/YAML (team files, packages, `SOUL.md`,
 * `CLAW.md`, `distribution.yaml`, `COMPANY.md`…), agent definitions
 * (`agents/x.yaml`, `agents/x/AGENTS.md`), skills with their references,
 * the legacy OpenClaw cron jobs, then memory, newest first. Nothing else.
 */
const ALLOWED = [
  /^[^/]+\.(md|markdown|json|ya?ml)$/i,
  /^agents\/([^/]+\/)?[^/]+\.(md|markdown|json|ya?ml)$/i,
  /^(\.agents\/)?skills\/([^/]+\/){1,4}[^/]+\.(md|markdown)$/i,
  /^cron\/jobs\.json$/i,
  /^memor(y|ies)\/[^/]+\.md$/i,
];
const MEMORY = ALLOWED.length - 1;
/** Where other apps keep keys and sign-ins: never read, even when the name fits the list. */
export const SECRET_FILE =
  /^(\.env.*|auth(-profiles)?\.json|credentials?\..*|secrets?\..*|mcp-(oauth|tokens).*|cursor-session\.json)$/i;
/** Requests to GitHub at a time. */
const PARALLEL = 8;

/** `github`: the workspace's GitHub (its connection, the GitHub App), for private repositories. */
export type AgentImportDeps = GithubReadDeps;

export interface ImportedFile {
  /** Relative to the linked folder (or the file's own name). */
  path: string;
  text: string;
}

interface TreeEntry {
  path: string;
  type: string;
  mode: string;
  size?: number;
}

const TOO_LARGE = "The file is too large (max 4 MB)";
const notImportable = () => new ValidationError("Link a Markdown, JSON or YAML file");

/** The file a file link names, when it is one an import reads. */
function linkedFile(path: string) {
  const name = path.split("/").pop() ?? path;
  if (!ALLOWED[0]?.test(name) || SECRET_FILE.test(name)) throw notImportable();
  return name;
}

/**
 * Which of a folder's files are read (`entries`: the repository's, symbolic links already out), relative to the
 * folder, and which fit the list but not the limits.
 */
function pickFiles(entries: { path: string; size: number }[], folder: string) {
  const base = folder.replace(/^\/+|\/+$/g, "");
  const prefix = base ? `${base}/` : "";
  const found = entries.flatMap((entry) => {
    if (!entry.path.startsWith(prefix)) return [];
    const path = entry.path.slice(prefix.length);
    const group = ALLOWED.findIndex((pattern) => pattern.test(path));
    if (group < 0 || SECRET_FILE.test(path.split("/").pop() ?? "")) return [];
    return [{ path, group, size: entry.size }];
  });
  if (found.length === 0) throw new ValidationError("No Markdown, JSON or YAML files in that folder");
  // Daily memory files are named by date: the newest go first when the limits cut.
  found.sort((a, b) => a.group - b.group || (a.group === MEMORY ? b.path.localeCompare(a.path) : 0));

  const chosen: typeof found = [];
  const skipped: string[] = [];
  let total = 0;
  for (const file of found) {
    const fits =
      chosen.length < AGENT_IMPORT_LIMITS.maxFiles &&
      file.size <= AGENT_IMPORT_LIMITS.fileBytes &&
      total + file.size <= AGENT_IMPORT_LIMITS.maxBytes;
    if (!fits) {
      skipped.push(file.path);
      continue;
    }
    chosen.push(file);
    total += file.size;
  }
  return { prefix, chosen, skipped };
}

type GithubTarget = ReturnType<typeof parseGithubUrl>;
type Imported = { files: ImportedFile[]; skipped?: string[] };

/** The link read as anyone reads github.com: raw files, and one recursive tree request for a folder. */
async function readPublic(deps: AgentImportDeps, target: GithubTarget): Promise<Imported> {
  const read = async (path: string) => {
    const raw = `https://raw.githubusercontent.com/${target.owner}/${target.repo}/${encodePath(target.ref)}/${encodePath(path)}`;
    const data = await fetchGithub(deps, raw, "text/plain", {
      maxBytes: AGENT_IMPORT_LIMITS.fileBytes,
      tooLarge: TOO_LARGE,
    });
    return new TextDecoder().decode(data);
  };
  if (target.kind === "file") return { files: [{ path: linkedFile(target.path), text: await read(target.path) }] };

  const listing = JSON.parse(
    new TextDecoder().decode(
      await fetchGithub(
        deps,
        `https://api.github.com/repos/${target.owner}/${target.repo}/git/trees/${encodeURIComponent(target.ref)}?recursive=1`,
        "application/vnd.github+json",
        { maxBytes: 8 * 1024 * 1024, tooLarge: "The repository is too large to list. Link a file instead." },
      ),
    ),
  ) as { tree?: TreeEntry[]; truncated?: boolean };
  if (!Array.isArray(listing.tree)) throw new ValidationError("That URL is not a folder");
  if (listing.truncated) throw new ValidationError("The repository is too large to list. Link a file instead.");
  // Symbolic links (mode 120000) could point anywhere in the repository.
  const blobs = listing.tree.filter((entry) => entry.type === "blob" && entry.mode !== "120000");
  const { prefix, chosen, skipped } = pickFiles(
    blobs.map((entry) => ({ path: entry.path, size: entry.size ?? 0 })),
    target.path,
  );
  const files: ImportedFile[] = [];
  for (let i = 0; i < chosen.length; i += PARALLEL) {
    const batch = chosen.slice(i, i + PARALLEL);
    const texts = await Promise.all(batch.map((file) => read(prefix + file.path)));
    batch.forEach((file, j) => {
      files.push({ path: file.path, text: texts[j] ?? "" });
    });
  }
  return skipped.length > 0 ? { files, skipped } : { files };
}

/**
 * The same files out of a private repository's archive, downloaded once with one of the workspace's tokens. Null
 * when github.com shows the repository: what the link names in it is missing.
 */
async function readHidden(deps: AgentImportDeps, orgId: string, target: GithubTarget): Promise<Imported | null> {
  const repository = await hiddenRepository(deps, orgId, target);
  if (!repository) return null;
  const text = (path: string) => {
    const entry = repository.files.get(path);
    if (!entry) throw new ValidationError(`${path} isn't in that repository`);
    if (entry.size > AGENT_IMPORT_LIMITS.fileBytes) throw new ValidationError(TOO_LARGE);
    return new TextDecoder().decode(inflateZipEntry(repository.zip, entry));
  };
  if (target.kind === "file") return { files: [{ path: linkedFile(target.path), text: text(target.path) }] };
  const { prefix, chosen, skipped } = pickFiles(
    [...repository.files].map(([path, entry]) => ({ path, size: entry.size })),
    target.path,
  );
  const files = chosen.map((file) => ({ path: file.path, text: text(prefix + file.path) }));
  return skipped.length > 0 ? { files, skipped } : { files };
}

/**
 * The text files behind a GitHub link: one file (`/blob/…` or raw), or the
 * allowlisted files under a folder (`/tree/…` or the repository). `skipped`:
 * files that fit the list but not the limits. Never runs or stores anything.
 *
 * A repository github.com hides is read through the workspace's GitHub (the
 * GitHub App's token for it, else the connection's) for who edits any agent
 * (`manage_agents`, as installing a skill from a private repository asks):
 * `github.repo_missing` when none reads it, or for anyone else.
 */
export async function readGithubImport(
  deps: AgentImportDeps,
  actorId: string,
  orgId: string,
  url: string,
): Promise<Imported> {
  const membership = await requirePermission(deps.db, actorId, orgId, "create_agents");
  let target: GithubTarget;
  try {
    target = parseGithubUrl(url);
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError("Unrecognized GitHub URL");
  }
  if (target.kind === "file") linkedFile(target.path);
  try {
    return await readPublic(deps, target);
  } catch (missing) {
    if (!(missing instanceof GithubMissingError)) throw missing;
    const through = can(membership, "manage_agents") ? deps : { ...deps, github: undefined };
    const hidden = await readHidden(through, orgId, target);
    if (!hidden) throw missing;
    return hidden;
  }
}
