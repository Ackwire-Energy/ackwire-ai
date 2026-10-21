/**
 * Two rules for the public repository, run in CI via `bun run check:boundaries`:
 *
 * - The edition boundary (docs/adr/0002-editions-and-modules.md): open-source code under apps/ and
 *   packages/ must never import a Cloud-only package (`@agenteschat/cloud`) or an `@agenteschat/ee` module.
 * - No internal notes: every file outside PRIVATE_PATHS is public, comments included, so none may point
 *   at the private docs (the planning doc's decision ids, the progress logs, the prototype screens) or
 *   name the team's other projects, companies and repositories.
 */
import { createHash } from "node:crypto";
import { Glob } from "bun";

/**
 * The only files that stay out of the public repository. Internal notes (planning, progress, prototypes,
 * instructions about the team's own machines) go in these files and nowhere else.
 */
export const PRIVATE_PATHS = [
  "docs/planejamento.md",
  "docs/backend-progress.md",
  "docs/frontend-progress.md",
  "docs/prototipo/",
  "docs/design/telas/",
  "railway.json",
  ".claude/rules/internal-docs.md",
];

export function isPrivate(path: string): boolean {
  return PRIVATE_PATHS.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
}

/** Public files that hold the patterns on purpose: this check, its samples and the ignore rule for local prototypes. */
const NAMES_PRIVATE_PATHS = new Set(["scripts/check-boundaries.ts", "scripts/check-boundaries.test.ts", ".gitignore"]);

/** A planning decision id in running text: "(D46)", "D60: …", "D9–D13". Cloudflare's D1 is a product name. */
const DECISION_ID = /(?<=^|[\s([,;–])D\d{1,2}[a-c]?(?=$|[\s)\],;:.'’–-])(?<!R2 (?:and|e) D1)/;

const NOTES: [RegExp, string][] = [
  [DECISION_ID, "cites a planning decision id: cite the ADR or state the reason itself"],
  [
    /(?:planejamento|backend-progress|frontend-progress)\.md|docs\/prototipo|docs\/design\/telas|\btelas\//,
    "points at a private doc",
  ],
  [/(?<![\w./-])[A-Z][A-Za-z0-9]*\.(?:dc\.)?html\b/, "names a prototype screen"],
  [/claude\.ai\/(?:code\/)?artifact/, "links a private claude.ai artifact"],
];

/**
 * SHA-256 of words no public file may contain: the team's other project and company, the product's
 * former name, an Apple team id and the private Cloud repository. Hashed so this file doesn't publish them;
 * add one, in lowercase, with `printf %s word | shasum -a 256`.
 */
const PRIVATE_WORDS = new Set([
  "49a9f16c112863fbcd5f840da8fd0d18c8cd4f1ff43cf601a89998c25138da4f",
  "4a5c0838bb397331a4f27195980b69ecfadc67379cb29f281842e38147b06955",
  "4215a347ee21606e7da0cb76ad84dc9a647c9ebfdfa986d194acfd0bf080281c",
  "ff291731fc8e904455a0399bc5154213041396596a2d0857f27a66b473593f2e",
  "5a686fdaa0c9ea14840b98c25a1f626d362132ccf94e33356d4b71c73ac5907f",
]);

const hashes = new Map<string, string>();

/** Whether a line holds one of the hashed words, alone or inside a hyphenated name. */
function hasPrivateWord(line: string, privateWords: Set<string>): boolean {
  for (const name of line.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? []) {
    for (const word of name.includes("-") ? [name, ...name.split("-")] : [name]) {
      const hash = hashes.get(word) ?? createHash("sha256").update(word).digest("hex");
      hashes.set(word, hash);
      if (privateWords.has(hash)) return true;
    }
  }
  return false;
}

/** The internal notes in a public file's text, as `line: what is wrong`. */
export function internalNotes(text: string, privateWords = PRIVATE_WORDS): string[] {
  const hits: string[] = [];
  text.split("\n").forEach((line, i) => {
    for (const [pattern, why] of NOTES) if (pattern.test(line)) hits.push(`${i + 1}: ${why}`);
    if (hasPrivateWord(line, privateWords)) hits.push(`${i + 1}: names an internal project, company or repository`);
  });
  return hits;
}

if (import.meta.main) {
  const forbidden =
    /(from\s+|import\s*\(\s*|require\s*\(\s*)["'](@agenteschat\/(cloud|ee)(\/[^"']*)?|(\.\.\/)+(cloud|ee)(\/[^"']*)?)["']/;
  const violations: string[] = [];

  for (const dir of ["apps", "packages"]) {
    for await (const file of new Glob(`${dir}/**/*.{ts,tsx,js,mjs}`).scan({ dot: false })) {
      if (file.includes("node_modules") || file.includes("/dist/")) continue;
      const text = await Bun.file(file).text();
      text.split("\n").forEach((line, i) => {
        if (forbidden.test(line)) violations.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
  }

  for (const pkgFile of ["apps", "packages"].flatMap((d) => [...new Glob(`${d}/*/package.json`).scanSync()])) {
    const pkg = await Bun.file(pkgFile).json();
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    for (const name of ["@agenteschat/cloud", "@agenteschat/ee"]) {
      if (name in deps) violations.push(`${pkgFile}: depends on ${name}`);
    }
  }

  // Tracked files and new ones not ignored, so a file is checked before its first commit too.
  const git = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (!git.success) throw new Error(`git ls-files failed: ${git.stderr.toString()}`);
  const notes: string[] = [];
  for (const path of git.stdout.toString().split("\0")) {
    if (!path || isPrivate(path) || NAMES_PRIVATE_PATHS.has(path)) continue;
    const file = Bun.file(path);
    if (!(await file.exists())) continue; // deleted, not staged yet
    const text = await file.text();
    if (text.includes("\0")) continue; // binary
    for (const hit of internalNotes(text)) notes.push(`${path}:${hit}`);
  }

  if (violations.length > 0) {
    console.error(`Open-source code must not depend on cloud/ or ee/:\n${violations.join("\n")}`);
  }
  if (notes.length > 0) {
    console.error(
      "Internal notes in public files: cite the ADR or state the reason, or move the note to PRIVATE_PATHS:",
    );
    console.error(notes.join("\n"));
  }
  if (violations.length > 0 || notes.length > 0) process.exit(1);
  console.log("boundaries ok");
}
