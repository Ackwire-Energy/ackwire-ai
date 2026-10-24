import path from "node:path";
import { commandParts, ruleMatches } from "./machine-protocol";

/**
 * Deterministic command policy for computer turns (ADR 0029, ADR 0053 §3). No
 * model: plain parsing of the call Claude Code (or Codex) wants to make. The
 * runner's permission prompt, Codex's command approvals and the server's
 * `permission_prompt` all decide with these functions, so every brain follows
 * the same rules.
 *
 * - `deniedInMissions`: the deny list, matched on normalized arguments (`gh -R`,
 *   `git -C/-c`, `refs/heads/<default>`): refused at once, never asked.
 * - `secretRead`: a call that reads keys, tokens or env files, with any read
 *   tool (Read, Glob, Grep, a shell command): refused at once too. Only calls
 *   that reach a prompt are seen: Claude Code's own reads meet the same list
 *   as deny rules (`SECRET_READ_DENY_RULES`); Codex runs the commands it deems
 *   safe (`cat`, `grep`…) without asking, so there secrets are kept from
 *   leaving rather than from being read (ADR 0053 §3).
 * - `readOnlyCall`: harmless reads (listing and reading files anywhere but
 *   secrets, read-only git, GET/HEAD fetches that save only into the
 *   mission folder; in the `plan` profile no fetch and no write at all). The
 *   runner's prompt tool allows these at once, with no card and nothing posted.
 * - `forbiddenReason`: what code never lets the judge approve (sudo, deletes
 *   and writes outside the mission folder, system services, uploads, remote
 *   shells, global installs, inline code, anything it can't read plainly).
 *   The judge only classifies what is left; the deny list stays first and hard.
 * - `localVerdict`: the part the computer decides by itself (the rest goes to
 *   the server, which may ask a person).
 *
 * Anything this can't parse with certainty is "not read-only" (a card).
 */

/**
 * The permission profile of a computer turn (ADR 0053 §3). `plan`: reads only
 * (no edits, read-only shell, no web, no fetches). `work`: edits in its folders,
 * and commands by this policy (a person for the rest).
 */
export type CommandProfile = "plan" | "work";

export interface CommandScope {
  /** Where the task runs (relative paths resolve here). */
  cwd: string;
  /** The mission folder and the task's own folder: writes are allowed inside. */
  folders: string[];
  /** The person's home, for `~`. */
  home?: string;
  /** The runner's own home wherever it is (`AGENTES_RUNNER_HOME`): its accounts, tokens and settings are secrets. */
  runnerHome?: string;
}

type Word = { text: string; op?: undefined } | { text: string; op: "pipe" | "list" | "redirect" | "input" };

/**
 * Shell words with quotes removed and operators split out. `null` when the
 * line uses anything we don't follow: command substitution, process
 * substitution, variables, globs into hidden expansions, heredocs, `&` jobs.
 */
export function shellWords(line: string): Word[] | null {
  const out: Word[] = [];
  let cur = "";
  let has = false;
  const push = () => {
    if (has) out.push({ text: cur });
    cur = "";
    has = false;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return null;
      cur += line.slice(i + 1, end);
      has = true;
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        const d = line[j] as string;
        if (d === "$" || d === "`") return null;
        if (d === "\\" && j + 1 < line.length) {
          j++;
          cur += line[j];
        } else cur += d;
      }
      if (j >= line.length) return null;
      has = true;
      i = j;
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= line.length) return null;
      cur += line[i + 1];
      has = true;
      i++;
      continue;
    }
    if (c === "$" || c === "`" || c === "(" || c === ")" || c === "{" || c === "}") return null;
    if (c === " " || c === "\t") {
      push();
      continue;
    }
    if (c === "\n" || c === ";") {
      push();
      out.push({ text: ";", op: "list" });
      continue;
    }
    if (c === "|") {
      push();
      if (line[i + 1] === "|") {
        out.push({ text: "||", op: "list" });
        i++;
      } else if (line[i + 1] === "&") return null;
      else out.push({ text: "|", op: "pipe" });
      continue;
    }
    if (c === "&") {
      if (line[i + 1] === "&") {
        push();
        out.push({ text: "&&", op: "list" });
        i++;
        continue;
      }
      if (line[i + 1] === ">") {
        push();
        const append = line[i + 2] === ">";
        out.push({ text: append ? "&>>" : "&>", op: "redirect" });
        i += append ? 2 : 1;
        continue;
      }
      // `2>&1`: the fd duplication, harmless.
      if (cur === "" && out.at(-1)?.op === "redirect" && /^\d$/.test(line[i + 1] ?? "")) {
        out.push({ text: `&${line[i + 1]}` });
        i++;
        continue;
      }
      return null; // a background job
    }
    if (c === ">" || c === "<") {
      if (c === "<" && line[i + 1] === "<") return null; // heredoc / herestring
      // `2>`: the digit before belongs to the operator.
      const fd = /^\d$/.test(cur) ? cur : "";
      if (!fd) push();
      else {
        cur = "";
        has = false;
      }
      if (c === ">") {
        const append = line[i + 1] === ">";
        out.push({ text: `${fd}${append ? ">>" : ">"}`, op: "redirect" });
        if (append) i++;
      } else out.push({ text: "<", op: "input" });
      continue;
    }
    cur += c;
    has = true;
  }
  push();
  return out;
}

interface Simple {
  argv: string[];
  /** Files written by `>`/`>>` (not `/dev/null`, not `2>&1`). */
  writes: string[];
  /** Files read by `<`. */
  reads: string[];
}

/** The simple commands of a line (pipelines and lists split), or null when it can't be followed. */
export function simpleCommands(line: string): Simple[] | null {
  const words = shellWords(line);
  if (!words) return null;
  const out: Simple[] = [];
  let cur: Simple = { argv: [], writes: [], reads: [] };
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as Word;
    if (w.op === "pipe" || w.op === "list") {
      if (cur.argv.length === 0) return null;
      out.push(cur);
      cur = { argv: [], writes: [], reads: [] };
      continue;
    }
    if (w.op === "redirect" || w.op === "input") {
      const target = words[i + 1];
      if (!target || target.op) return null;
      i++;
      if (w.op === "input") cur.reads.push(target.text);
      else if (/^&\d$/.test(target.text)) continue;
      else if (target.text !== "/dev/null") cur.writes.push(target.text);
      continue;
    }
    cur.argv.push(w.text);
  }
  if (cur.argv.length === 0) return out.length ? null : [];
  out.push(cur);
  // `FOO=1 cmd`: an env assignment in front; keep it simple and refuse.
  if (out.some((s) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(s.argv[0] ?? ""))) return null;
  return out;
}

const TMP = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/var/folders", "/private/var/folders"];

function resolveIn(scope: CommandScope, p: string) {
  const home = scope.home ?? "";
  const expanded = p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
  if (expanded.startsWith("~")) return null; // `~other`
  return path.resolve(scope.cwd, expanded);
}

const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** Inside the mission folder (or the task's own). */
export function insideFolders(scope: CommandScope, p: string) {
  const r = resolveIn(scope, p);
  return r !== null && scope.folders.some((f) => under(r, path.resolve(f)));
}

const insideOrTmp = (scope: CommandScope, p: string) => {
  const r = resolveIn(scope, p);
  return r !== null && (insideFolders(scope, p) || TMP.some((t) => under(r, t)));
};

/**
 * System mode: where each agent's worker keeps its own secrets, git credentials and task journal
 * (`<this>/<the agent's user>`). The agent's commands run as that user too, so only these rules keep its
 * model from reading them.
 */
export const AGENT_WORKER_HOMES = "/var/lib/agentes-runner-agents";

/**
 * System mode's runner home (`install.sh --system`), and the state of the server's own computer
 * (`agentes-runner host`): every organization's machine token is in it.
 */
export const SYSTEM_RUNNER_HOME = "/var/lib/agentes-runner";

/** In the person's home only: the native install (the app, its `.env`, its database). Agents' own folders have a `.agentes` of theirs. */
const HOME_SECRET_DIRS = [".agentes"] as const;

/**
 * Folders that hold keys and tokens, anywhere (the runner's own home and its agents' workers' too): nothing
 * under them is read. One list for the server's checks (`SECRET_PATH`) and Claude Code's own rules
 * (`SECRET_READ_DENY_RULES`).
 */
const SECRET_DIRS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".azure",
  ".gcloud",
  ".password-store",
  "Keychains",
  ".agentes-runner",
  path.basename(AGENT_WORKER_HOMES),
  SYSTEM_RUNNER_HOME.slice(1),
  ".config/gh",
  ".config/gcloud",
] as const;
/** Files that hold tokens, anywhere (a project's `.npmrc` or service account too; Claude Code's own sign-in). */
const SECRET_FILES = [
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".pgpass",
  "credentials",
  "credentials.json",
  ".credentials.json",
  "mcp-token",
] as const;
/**
 * Sign-ins by a name too common to refuse everywhere: Codex's own, and what an account folder
 * (`accounts/<kind>/<id>`) holds (Codex's sign-in, a coding plan's key).
 */
const SECRET_SIGN_IN_FILES = [".codex/auth.json", "accounts/*/*/auth.json", "accounts/*/*/provider.json"] as const;
/** Env files with values in them; `.env.example` and the like hold none (`SECRET_PATH` refuses every other `.env.*`). */
const SECRET_ENV_FILES = [
  ".env",
  ".env.local",
  ".env.*.local",
  ".env.production",
  ".env.prod",
  ".env.prd",
  ".env.development",
  ".env.dev",
  ".env.staging",
  ".env.stage",
  ".env.preview",
  ".env.test",
  ".env.ci",
  ".env.qa",
  ".env.uat",
  ".env.backup",
  ".env.bak",
  ".env.old",
] as const;
/** Keys and certificates, by name. */
const SECRET_KEY_FILES = ["*.pem", "*.key", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"] as const;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Secrets a read never gets: keys, tokens, env files (not their `.env.example`
 * and the like, which hold none), the runner's own home.
 */
const SECRET_PATH = new RegExp(
  `(^|/)(${SECRET_DIRS.map(escapeRe).join("|")})(/|$)|^~/(${HOME_SECRET_DIRS.map(escapeRe).join("|")})(/|$)|(^|/)(${SECRET_FILES.map(escapeRe).join("|")}|\\.env(\\.(?!(example|sample|template|dist|defaults)$)[\\w.-]+)?|id_[a-z0-9]+(\\.pub)?|.*\\.pem|.*\\.key)$|(^|/)(${SECRET_SIGN_IN_FILES.map((f) => escapeRe(f).replaceAll("\\*", "[^/]+")).join("|")})$`,
  "i",
);

function secretPath(scope: CommandScope, p: string) {
  const r = resolveIn(scope, p);
  const home = scope.home;
  return (
    r === null ||
    SECRET_PATH.test(r) ||
    SECRET_PATH.test(p) ||
    (home !== undefined && HOME_SECRET_DIRS.some((d) => under(r, path.join(home, d)))) ||
    (scope.runnerHome !== undefined && under(r, path.resolve(scope.runnerHome)))
  );
}

/** A command that names the variables pointing at an account's sign-in, or holding a plan's key. */
const SECRET_VARIABLE = /\$\{?(CLAUDE_CONFIG_DIR|CODEX_HOME|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY)\b/;

/** A word of a line that can't be parsed plainly, without the quotes and substitution marks around it (`$(cat`, `x)`). */
const bareWord = (w: string) => w.replace(/^[$('"`{]+|[)'"`};]+$/g, "");

/**
 * A path or pattern names a secret (resolved in the scope when there is one, if it can leave the folder it
 * runs in; a bare one is tested as written).
 */
const namesSecret = (p: string, scope?: CommandScope) =>
  SECRET_PATH.test(p) ||
  (scope !== undefined && (p.startsWith("/") || p.startsWith("~") || p.includes("..")) && secretPath(scope, p));

/** Claude Code's own tools that read files, and the arguments that say where (Grep's `pattern` is a search, not a path). */
const FILE_READ_TOOLS: Record<string, readonly string[]> = {
  Read: ["file_path"],
  Glob: ["pattern", "path"],
  Grep: ["path", "glob"],
  LS: ["path"],
  NotebookRead: ["notebook_path"],
};

/**
 * A call that reads a secret (keys, tokens, env files, the runner's own home),
 * with any tool that reads: Read, Glob, Grep (by path, glob or pattern) and
 * shell commands (any word naming one, or a file read with `<`). Refused at
 * once on every path (ADR 0053 §3); a person never sees it as a card.
 */
export function secretRead(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
  scope?: CommandScope,
): boolean {
  const i = input ?? {};
  const keys = Object.hasOwn(FILE_READ_TOOLS, toolName) ? FILE_READ_TOOLS[toolName] : undefined;
  if (keys) return keys.some((k) => typeof i[k] === "string" && namesSecret(i[k] as string, scope));
  if (toolName !== "Bash") return false;
  const command = typeof i.command === "string" ? i.command : "";
  if (SECRET_VARIABLE.test(command)) return true;
  const cmds = simpleCommands(command);
  if (cmds) {
    return cmds.some(
      (s) => s.argv.slice(1).some((a) => namesSecret(a, scope)) || s.reads.some((r) => namesSecret(r, scope)),
    );
  }
  // Not plainly readable: any word that names a secret.
  return commandParts(command).some((part) =>
    part
      .split(" ")
      .slice(1)
      .some((w) => namesSecret(bareWord(w), scope)),
  );
}

/** Commands that only read, whatever their arguments (minus the options that write or run). */
const READ_ANY = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "stat",
  "wc",
  "du",
  "df",
  "which",
  "whereis",
  "type",
  "sw_vers",
  "uname",
  "system_profiler",
  "fc-list",
  "mdls",
  "pwd",
  "grep",
  "egrep",
  "fgrep",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "echo",
  "printf",
  "true",
  "uniq",
  "cut",
  "nl",
  "column",
  "md5",
  "md5sum",
  "shasum",
  "sha256sum",
  "otool",
  "lipo",
  "whoami",
  "id",
  "date",
]);
/** Options that make an otherwise read-only command write or run something. */
const WRITE_FLAGS: Record<string, RegExp> = {
  sort: /^(-o|--output)/,
  tree: /^-o$/,
  rg: /^(--pre|--pre-glob)/,
  file: /^-C$|^--compile/,
  identify: /^[-+]write$/,
};
const READ_WITH_FLAGS = new Set(["sort", "tree", "rg", "file", "identify"]);

const FIND_ACTIONS = /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/;
const SIPS_READ = new Set(["-g", "--getProperty", "-1", "--oneLine"]);
/** exiftool options that write (and any `-TAG=value` assignment). */
const EXIF_WRITE =
  /^-(o|out|w|W|tagsFromFile|geotag|geosync|overwrite_original|overwrite_original_in_place|delete_original!?|restore_original|srcfile|@|k|P|config)$|^-.*=/;

const GIT_SAFE_BRANCH = new Set([
  "--list",
  "-l",
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--verbose",
  "--show-current",
  "--contains",
  "--merged",
  "--no-merged",
  "--no-color",
  "--color",
]);

/** Read-only git anywhere: status, log, diff, show, branch (listing), remote -v, rev-parse, ls-files. */
function readOnlyGit(argv: string[]) {
  let i = 1;
  // `git -C <path>` and `--no-pager` in front; `-c` (config) could run anything.
  for (; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "-C") i++;
    else if (a === "--no-pager") continue;
    else break;
  }
  const sub = argv[i];
  const rest = argv.slice(i + 1);
  if (rest.some((a) => /^--(output|ext-diff|textconv|exec)/.test(a) || a === "-c")) return false;
  switch (sub) {
    case "status":
    case "log":
    case "diff":
    case "show":
    case "rev-parse":
    case "ls-files":
    case "shortlog":
    case "describe":
    case "blame":
      return true;
    case "branch": {
      if (rest.length === 0) return true;
      // Listing only: a bare name would create a branch.
      if (rest[0] === "--list" || rest[0] === "-l")
        return rest.slice(1).every((a) => GIT_SAFE_BRANCH.has(a) || !a.startsWith("-"));
      return rest.every((a) => GIT_SAFE_BRANCH.has(a));
    }
    case "remote":
      return (
        rest.length === 0 ||
        (rest.length === 1 && (rest[0] === "-v" || rest[0] === "--verbose")) ||
        (rest[0] === "get-url" && rest.length <= 3)
      );
    default:
      return false;
  }
}

const HTTP_URL = /^https?:\/\/[^\s]+$/i;

/** curl options that take a value (the next word, or glued: `-oout.txt`, `--output=x`). */
const CURL_ARG = new Set("A b c C D e E H m o r u U w x X y Y z".split(" "));
const CURL_ARG_LONG = new Set([
  "user-agent",
  "cookie",
  "cookie-jar",
  "continue-at",
  "dump-header",
  "referer",
  "cert",
  "header",
  "max-time",
  "connect-timeout",
  "output",
  "output-dir",
  "range",
  "user",
  "proxy-user",
  "write-out",
  "proxy",
  "request",
  "retry",
  "retry-delay",
  "retry-max-time",
  "speed-time",
  "speed-limit",
  "time-cond",
  "max-redirs",
  "max-filesize",
  "cacert",
  "resolve",
  "connect-to",
  "interface",
  "limit-rate",
  "trace",
  "trace-ascii",
  "stderr",
  "etag-save",
  "etag-compare",
  "hsts",
  "alt-svc",
  "url",
]);
/** Never auto-allowed: sending data, reading a config of options, FTP commands. */
const CURL_SENDS = /^(d|F|T|K|Q|t|P)$/;
const CURL_SENDS_LONG = /^(data.*|form.*|upload-file|json|config|quote|telnet-option|ftp-port|mail-.*|upload.*)$/;
const CURL_WRITES = new Set([
  "o",
  "D",
  "c",
  "output",
  "output-dir",
  "dump-header",
  "cookie-jar",
  "trace",
  "trace-ascii",
  "stderr",
  "etag-save",
  "hsts",
  "alt-svc",
]);

function readOnlyCurl(argv: string[], scope: CommandScope) {
  let urls = 0;
  const value = (name: string, v: string) => {
    if (name === "X" || name === "request") return /^(GET|HEAD)$/i.test(v);
    if (name === "w" || name === "write-out") return !/%output\{|%\{stderr/.test(v);
    if (name === "url") return HTTP_URL.test(v) && ++urls > 0;
    if (CURL_WRITES.has(name)) return insideFolders(scope, v);
    return true;
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const [rawName, glued] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      const name = rawName.replace(/^no-/, "");
      if (CURL_SENDS_LONG.test(name)) return false;
      if (CURL_ARG_LONG.has(name)) {
        const v = glued ?? argv[++i];
        if (v === undefined || !value(name, v)) return false;
      }
      if (name === "remote-name" || name === "remote-name-all") {
        if (!insideFolders(scope, ".")) return false;
      }
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j] as string;
        if (CURL_SENDS.test(c)) return false;
        if (c === "O" || c === "J") {
          if (!insideFolders(scope, ".")) return false;
          continue;
        }
        if (CURL_ARG.has(c)) {
          const v = j + 1 < a.length ? a.slice(j + 1) : argv[++i];
          if (v === undefined || !value(c, v)) return false;
          break;
        }
      }
      continue;
    }
    if (!HTTP_URL.test(a)) return false;
    urls++;
  }
  return urls > 0;
}

const WGET_ARG_LONG = new Set([
  "output-document",
  "directory-prefix",
  "output-file",
  "append-output",
  "user-agent",
  "header",
  "timeout",
  "tries",
  "wait",
  "level",
  "user",
  "password",
  "method",
  "referer",
  "input-file",
  "accept",
  "reject",
]);
const WGET_ARG = new Set("O P o a U t T w l i A R e".split(" "));
const WGET_SENDS = /^(post-data|post-file|body-data|body-file|execute|use-askpass|config)$/;
const WGET_WRITES = new Set([
  "O",
  "P",
  "o",
  "a",
  "output-document",
  "directory-prefix",
  "output-file",
  "append-output",
]);

function readOnlyWget(argv: string[], scope: CommandScope) {
  let urls = 0;
  // Without -O / -P it saves into the current folder.
  let savesHere = true;
  const value = (name: string, v: string) => {
    if (name === "method") return /^(GET|HEAD)$/i.test(v);
    if (name === "e") return false;
    if (WGET_WRITES.has(name)) {
      if (name === "O" || name === "output-document" || name === "P" || name === "directory-prefix") savesHere = false;
      return v === "-" || v === "/dev/null" || insideFolders(scope, v);
    }
    return true;
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const [name, glued] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      if (WGET_SENDS.test(name)) return false;
      if (WGET_ARG_LONG.has(name)) {
        const v = glued ?? argv[++i];
        if (v === undefined || !value(name, v)) return false;
      }
      if (name === "spider") savesHere = false;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j] as string;
        if (WGET_ARG.has(c)) {
          const v = j + 1 < a.length ? a.slice(j + 1) : argv[++i];
          if (v === undefined || !value(c, v)) return false;
          break;
        }
      }
      continue;
    }
    if (!HTTP_URL.test(a)) return false;
    urls++;
  }
  return urls > 0 && (!savesHere || insideFolders(scope, "."));
}

/** Options of `git clone/fetch/pull` that could run a program or read another config: never without a person. */
const GIT_FETCH_UNSAFE =
  /^(-c|-u|--config|--upload-pack|--receive-pack|--template|--separate-git-dir|--exec|--reference|--server-option|-o)(=|$)/;

/**
 * `git clone <https url> [dir]`, `git fetch` and `git pull` that only bring
 * code into the agent's (or mission's) folders: allowed without a person (ADR
 * 0024 addendum). In the agent's checkouts the remote is our git proxy (its
 * credential, its repositories); the deny list still stops pushes to the
 * default branch, force pushes and merges of pull requests.
 */
function fetchIntoFolders(argv: string[], scope: CommandScope) {
  let i = 1;
  let where = ".";
  for (; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "-C") {
      const dir = argv[++i];
      if (!dir) return false;
      where = where === "." ? dir : path.join(where, dir);
    } else if (a === "--no-pager") continue;
    else break;
  }
  const sub = argv[i];
  const rest = argv.slice(i + 1);
  if (rest.some((a) => GIT_FETCH_UNSAFE.test(a))) return false;
  // Remotes and refspecs only: no local paths, no `ext::`/`file:` transports.
  const plain = rest.filter((a) => !a.startsWith("-"));
  const local = (a: string) => a.includes("::") || /^(file:|\/|~|\.\.?(\/|$))/.test(a);
  const base = resolveIn(scope, where);
  if (base === null) return false;
  const at = { ...scope, cwd: base };
  switch (sub) {
    case "fetch":
    case "pull":
      return plain.every((a) => !local(a)) && insideFolders(scope, where);
    case "clone": {
      const [url, dir, ...extra] = plain;
      if (!url || extra.length > 0 || !/^https:\/\/[^/\s@]+\/\S+$/.test(url)) return false;
      const name =
        dir ??
        url
          .replace(/\/+$/, "")
          .replace(/\.git$/, "")
          .split("/")
          .at(-1) ??
        "";
      return Boolean(name) && insideFolders(at, name);
    }
    default:
      return false;
  }
}

function readOnlySimple(s: Simple, scope: CommandScope, plan = false): boolean {
  const [cmd, ...args] = s.argv;
  if (!cmd) return false;
  // A plan turn writes nothing, not even into its own folder.
  if (plan && s.writes.length > 0) return false;
  if (s.writes.some((w) => !insideFolders(scope, w))) return false;
  if (s.reads.some((r) => secretPath(scope, r))) return false;
  // Nothing that reads a secret, wherever it is named.
  if (args.some((a) => !a.startsWith("-") && namesSecret(a, scope))) return false;
  if (READ_ANY.has(cmd)) return true;
  if (READ_WITH_FLAGS.has(cmd)) return !args.some((a) => (WRITE_FLAGS[cmd] as RegExp).test(a));
  switch (cmd) {
    case "find":
      return !args.some((a) => FIND_ACTIONS.test(a));
    case "sips":
      return (
        args.some((a) => a === "-g" || a === "--getProperty") &&
        args.every((a) => !a.startsWith("-") || SIPS_READ.has(a))
      );
    case "exiftool":
      return !args.some((a) => EXIF_WRITE.test(a));
    case "git":
      // A plan turn fetches nothing (a clone or a pull writes into the folder).
      return readOnlyGit(s.argv) || (!plan && fetchIntoFolders(s.argv, scope));
    // No web in a plan turn, not even a GET.
    case "curl":
      return !plan && readOnlyCurl(s.argv, scope);
    case "wget":
      return !plan && readOnlyWget(s.argv, scope);
    default:
      return false;
  }
}

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);

/**
 * A call that only reads (or, in a `work` turn, fetches into the mission
 * folder): allowed at once, no card. Every part of a pipeline or list must be
 * read-only, so `curl … | sh` or `ls | xargs rm` never pass. Never a secret.
 */
export function readOnlyCall(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
  scope: CommandScope,
  profile: CommandProfile = "work",
) {
  const i = input ?? {};
  if (READ_TOOLS.has(toolName)) return !secretRead(toolName, i, scope);
  if (toolName !== "Bash") return false;
  const command = typeof i.command === "string" ? i.command : "";
  if (!command.trim() || command.length > 2000) return false;
  const cmds = simpleCommands(command);
  return Boolean(cmds && cmds.length > 0 && cmds.every((s) => readOnlySimple(s, scope, profile === "plan")));
}

/**
 * Never without a person's approval (`request_approval`): merges, pushes
 * elsewhere, force pushes, deploys, cluster/infra changes and package
 * publishes. Never promptable and never judged: Claude Code checks deny
 * before asking, the runner's prompt tool and the server refuse a match at once.
 */
export const MISSION_DENY_RULES: readonly string[] = [
  "Bash(git merge)",
  "Bash(git merge *)",
  "Bash(git -C * merge *)",
  "Bash(git -C * push --force*)",
  "Bash(git -C * push -f*)",
  "Bash(git -C * push * --force*)",
  "Bash(git -C * push * -f*)",
  "Bash(git -C * push *+*)",
  "Bash(git -C * push *:*)",
  "Bash(git -C * push * main)",
  "Bash(git -C * push * master)",
  "Bash(git push * main *)",
  "Bash(git push * master *)",
  "Bash(git -C * push * main *)",
  "Bash(git -C * push * master *)",
  "Bash(git -C * push * --delete *)",
  "Bash(git -C * push * -d *)",
  "Bash(git -C * push * --all*)",
  "Bash(git -C * push * --mirror*)",
  "Bash(git push --force*)",
  "Bash(git push -f*)",
  "Bash(git push * --force*)",
  "Bash(git push * -f*)",
  "Bash(git push *+*)",
  "Bash(git push *:*)",
  "Bash(git push * main)",
  "Bash(git push * master)",
  "Bash(git push --delete *)",
  "Bash(git push * --delete *)",
  "Bash(git push * -d *)",
  "Bash(git push --all*)",
  "Bash(git push * --all*)",
  "Bash(git push --mirror*)",
  "Bash(git push * --mirror*)",
  "Bash(gh pr merge *)",
  "Bash(gh api *)",
  "Bash(vercel deploy *)",
  "Bash(vercel --prod*)",
  "Bash(vercel * --prod*)",
  "Bash(npx vercel *)",
  "Bash(railway up*)",
  "Bash(railway deploy*)",
  "Bash(npx railway *)",
  "Bash(fly deploy*)",
  "Bash(flyctl deploy*)",
  "Bash(netlify deploy *)",
  "Bash(npx netlify *)",
  "Bash(eas submit *)",
  "Bash(eas update *)",
  "Bash(npx eas *)",
  "Bash(npx eas-cli *)",
  "Bash(kubectl apply *)",
  "Bash(kubectl rollout *)",
  "Bash(kubectl delete *)",
  "Bash(helm install *)",
  "Bash(helm upgrade *)",
  "Bash(helm uninstall *)",
  "Bash(terraform apply *)",
  "Bash(terraform destroy *)",
  "Bash(docker push*)",
  "Bash(gh release create*)",
  // Publishing packages (`bun publish` and friends; `yarn npm publish` is Yarn 2+).
  "Bash(npm publish*)",
  "Bash(pnpm publish*)",
  "Bash(yarn publish*)",
  "Bash(yarn npm publish*)",
  "Bash(bun publish*)",
  "Bash(cargo publish*)",
  "Bash(gem push*)",
  "Bash(twine upload*)",
  // The person's GitHub token, printed.
  "Bash(gh auth token*)",
  "Bash(gh auth status *--show-token*)",
  "Bash(gh auth status *-t*)",
];

/**
 * Code given inline to an interpreter (`node -e`, `python3 -c`, `perl -ne`…):
 * never allowed by a settings rule such as `Bash(node *)`, whatever else a
 * profile allows (Claude Code checks deny rules first). Our own check is
 * `inlineCode`, which also catches the spellings these patterns can't.
 */
export const INLINE_CODE_DENY_RULES: readonly string[] = [
  ...["node", "nodejs", "bun"].flatMap((i) =>
    ["-e", "--eval", "-p", "--print"].flatMap((f) => [`Bash(${i} ${f}*)`, `Bash(${i} * ${f} *)`]),
  ),
  ...["python", "python2", "python3"].flatMap((i) => [`Bash(${i} -c*)`, `Bash(${i} * -c *)`]),
  ...["ruby", "perl"].flatMap((i) => [`Bash(${i} -e*)`, `Bash(${i} * -e *)`, `Bash(${i} -*e *)`]),
  "Bash(perl -E*)",
  "Bash(deno eval*)",
  "Bash(php -r*)",
];

/**
 * Credential stores in the person's home (and the system-mode workers' own), named
 * in a shell command: refused by Claude Code itself even where a settings rule
 * allows the command (`Bash(cat *)` in a mission). Our own check is `secretRead`,
 * which covers more.
 */
export const SECRET_BASH_DENY_RULES: readonly string[] = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".azure",
  ".password-store",
  ".config/gh",
  ".config/gcloud",
  ".agentes-runner",
  path.basename(AGENT_WORKER_HOMES),
  SYSTEM_RUNNER_HOME.slice(1),
  ".git-credentials",
  ".netrc",
  ".pgpass",
  "Library/Keychains",
]
  .flatMap((p) => [`Bash(*~/${p}*)`, `Bash(*/${p}/*)`])
  .concat(HOME_SECRET_DIRS.map((p) => `Bash(*~/${p}*)`));

/**
 * The same secrets for Claude Code's own read tools (Read, and best effort Glob and Grep), from the
 * lists `SECRET_PATH` is built from: in the home folder and anywhere under the turn's folder. Its rules
 * can't say "every `.env.*` but the example", so the env files are the usual names.
 */
export const SECRET_READ_DENY_RULES: readonly string[] = [
  ...SECRET_DIRS.flatMap((p) => [`Read(~/${p}/**)`, `Read(**/${p}/**)`]),
  ...HOME_SECRET_DIRS.map((p) => `Read(~/${p}/**)`),
  "Read(~/Library/Keychains/**)",
  ...[...SECRET_FILES, ...SECRET_ENV_FILES, ...SECRET_KEY_FILES, ...SECRET_SIGN_IN_FILES].flatMap((p) => [
    `Read(~/${p})`,
    `Read(**/${p})`,
  ]),
];

/** Global options of git before its subcommand that take a value (`git -C <dir> push`, `git -c k=v push`). */
const GIT_GLOBAL_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
]);
const GIT_GLOBAL_FLAG =
  /^(--no-pager|-p|--paginate|-P|--bare|--no-replace-objects|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-optional-locks|--no-advice)$/;
/** gh options that pick another repository or host, anywhere in the command. */
const GH_VALUE = new Set(["-R", "--repo", "--hostname"]);
/** Wrappers that run the next word as the command (`nice -n 5 git push …`, `env -u X git push …`). */
const WRAPPERS = new Set(["command", "builtin", "nice", "nohup", "time", "env", "caffeinate"]);
/** Wrapper options that take the next word. */
const WRAPPER_VALUE = new Set(["-n", "-u", "-C", "-S", "-P", "-w", "-t"]);

const baseName = (word: string) => word.split("/").pop() ?? word;

/** The words with their wrappers (and the wrappers' options and env assignments) left out. */
function unwrapped(words: string[]): string[] {
  let argv = words.filter(Boolean);
  while (argv.length > 1 && WRAPPERS.has(baseName(argv[0] as string))) {
    argv = argv.slice(1);
    while (argv.length > 1 && /^-|^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0] as string)) {
      const opt = argv[0] as string;
      argv = argv.slice(WRAPPER_VALUE.has(opt) && argv.length > 2 ? 2 : 1);
    }
  }
  return argv;
}

/**
 * One command as the deny list reads it: its program by name (not path),
 * wrappers dropped, git's global options and gh's repository options left
 * out, and `refs/heads/<branch>` read as the branch, so `git -c x=y -C /w push
 * origin refs/heads/main` reads `git push origin main` and `gh -R a/b pr merge 1`
 * reads `gh pr merge 1`.
 */
export function normalizedCommand(words: string[]): string {
  const [first = "", ...rest] = unwrapped(words);
  const cmd = baseName(first);
  const out = [cmd];
  if (cmd === "git") {
    let i = 0;
    for (; i < rest.length; i++) {
      const a = rest[i] as string;
      if (GIT_GLOBAL_VALUE.has(a)) i++;
      else if (/^--(git-dir|work-tree|namespace|exec-path|config-env)=/.test(a) || GIT_GLOBAL_FLAG.test(a)) continue;
      else break;
    }
    out.push(...rest.slice(i).map((a) => a.replace(/^(\+?)refs\/heads\//, "$1").replace(/:refs\/heads\//, ":")));
  } else if (cmd === "gh") {
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i] as string;
      if (GH_VALUE.has(a)) i++;
      else if (!/^--(repo|hostname)=/.test(a)) out.push(a);
    }
  } else out.push(...rest);
  return out.join(" ");
}

/** The words of each part of a command (quotes dropped), for matching only: never to run anything. */
function commandWords(command: string): string[][] {
  const cmds = simpleCommands(command);
  if (cmds) return cmds.map((s) => s.argv);
  return commandParts(command).map((part) => part.split(" ").map(bareWord));
}

/**
 * On the deny list: refused at once, never shown to anyone, never judged. The
 * rules match the command as written and each part normalized
 * (`normalizedCommand`), so options in front can't slip past them.
 */
export function deniedInMissions(toolName: string, input: Record<string, unknown> | null | undefined) {
  if (MISSION_DENY_RULES.some((rule) => ruleMatches(rule, toolName, input))) return true;
  if (toolName !== "Bash") return false;
  const command = typeof input?.command === "string" ? input.command : "";
  return commandWords(command).some((words) => {
    const normalized = { command: normalizedCommand(words) };
    return MISSION_DENY_RULES.some((rule) => ruleMatches(rule, "Bash", normalized));
  });
}

/** Interpreters and the options that run code given on the command line. */
const INLINE_CODE: Array<[RegExp, RegExp]> = [
  [/^(node|nodejs|bun)$/, /^(-e|--eval|-p|--print|-pe|-ep)$|^--(eval|print)=/],
  // `-c` ends a cluster of python's flags (`-Bc`), or carries the code glued (`-cprint(1)`).
  [/^python[\d.]*$/, /^-[a-zA-Z]*c/],
  [/^ruby$/, /^-[a-zA-Z]*e/],
  [/^perl$/, /^-[a-zA-Z0-9]*[eE]/],
  [/^php$/, /^-r/],
];

/** Code given inline to an interpreter (`node -e`, `python3 -c`, `perl -ne`, `deno eval`): never auto-allowed. */
export function inlineCode(argv: readonly string[]): boolean {
  const [first = "", ...args] = unwrapped([...argv]);
  const base = baseName(first);
  if (base === "deno") return args.find((a) => !a.startsWith("-")) === "eval";
  const rule = INLINE_CODE.find(([name]) => name.test(base));
  if (!rule) return false;
  // Options before the script: the first plain word is the script, and what follows it is its own.
  for (const a of args) {
    if (!a.startsWith("-")) return false;
    if (rule[1].test(a)) return true;
  }
  return false;
}

/** Any part of a shell call runs inline code. */
export const inlineCodeCall = (toolName: string, input: Record<string, unknown> | null | undefined) =>
  toolName === "Bash" && commandWords(typeof input?.command === "string" ? input.command : "").some(inlineCode);

/** Told to the agent when the deny list refuses a call. */
export const DENIED_MESSAGE =
  "This command is never allowed for agents (merges, pushes to the default branch, deploys, publishing, printing tokens): ask with request_approval and wait.";
/** Told to the agent when a call reads a secret. */
export const SECRET_MESSAGE =
  "Agents never read secrets (keys, tokens, credentials, .env files). Do the work without them; if a search pattern only looks like one, search another way.";
/** Told to the agent when a plan turn wants more than reading. */
export const PLAN_MESSAGE =
  "This turn may only read: no edits, no commands that change anything, no web. Report what you would do instead.";

/**
 * What the computer decides by itself, before anyone is asked: the deny list
 * and secrets are refused, plain reads allowed; in a `plan` turn everything
 * else is refused too. Null: the server decides (`permission_prompt`: a
 * mission's card, or code's rules for a run). The runner's prompt tool for
 * Claude Code and its answers to Codex's command approvals both start here.
 */
export function localVerdict(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
  scope: CommandScope | undefined,
  profile: CommandProfile,
): { behavior: "allow" } | { behavior: "deny"; message: string } | null {
  if (deniedInMissions(toolName, input)) return { behavior: "deny", message: DENIED_MESSAGE };
  if (secretRead(toolName, input, scope)) return { behavior: "deny", message: SECRET_MESSAGE };
  if (scope && readOnlyCall(toolName, input, scope, profile)) return { behavior: "allow" };
  if (profile === "plan") return { behavior: "deny", message: PLAN_MESSAGE };
  return null;
}

// ── What the judge may never approve ──────────────────────────────────────────

const SYSTEM = new Set([
  "sudo",
  "doas",
  "su",
  "launchctl",
  "systemctl",
  "service",
  "shutdown",
  "reboot",
  "halt",
  "mkfs",
  "diskutil",
  "fdisk",
  "dd",
  "csrutil",
  "spctl",
  "defaults",
  "osascript",
  "crontab",
  "visudo",
  "passwd",
  "chsh",
  "nvram",
  "pmset",
  "kextload",
]);
const REMOTE = new Set(["ssh", "scp", "sftp", "rsync", "nc", "ncat", "netcat", "telnet", "ftp", "socat", "mosh"]);
const WRITERS = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "tee",
  "touch",
  "mkdir",
  "ln",
  "chmod",
  "chown",
  "chgrp",
  "truncate",
  "install",
  "unlink",
  "shred",
  "srm",
]);
const INTERPRETERS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "eval", "exec", "source", ".", "xargs"]);
/** Claude Code's tools that write a file (Codex's file changes are asked as `Write`). */
const FILE_WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Why code refuses a call even when the judge would allow it (null: the
 * judge may decide). Secrets for every read tool; the rest applies to Bash.
 */
export function forbiddenReason(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
  scope: CommandScope,
): string | null {
  if (secretRead(toolName, input, scope)) return "it touches secrets";
  // An edit asked for is outside what the turn may write by itself (its folders): only there, or /tmp.
  const edited = FILE_WRITE_TOOLS.has(toolName)
    ? [input?.file_path, input?.notebook_path].find((v): v is string => typeof v === "string")
    : undefined;
  if (edited !== undefined) {
    if (namesSecret(edited, scope)) return "it touches secrets";
    return insideOrTmp(scope, edited) ? null : "it changes files outside the mission folder";
  }
  if (toolName !== "Bash") return null;
  const command = typeof input?.command === "string" ? input.command : "";
  const cmds = simpleCommands(command);
  if (!cmds || cmds.length === 0) return "it can't be read plainly";
  for (const s of cmds) {
    const [cmd = "", ...args] = s.argv;
    const base = cmd.split("/").pop() ?? cmd;
    if (s.writes.some((w) => !insideOrTmp(scope, w))) return "it writes outside the mission folder";
    if (SYSTEM.has(base)) return "it changes the system";
    if (REMOTE.has(base)) return "it connects to another host";
    if (INTERPRETERS.has(base)) return "it runs other commands";
    if (inlineCode(s.argv)) return "it runs code given inline";
    if (WRITERS.has(base)) {
      const paths = args.filter((a) => !a.startsWith("-"));
      if (paths.some((p) => !insideOrTmp(scope, p))) return "it changes files outside the mission folder";
    }
    if (base === "curl" || base === "wget") {
      if (!readOnlySimple(s, scope)) return "it sends data or saves outside the mission folder";
    }
    if (/^(npm|pnpm|yarn|bun)$/.test(base) && args.some((a) => a === "-g" || a === "--global" || a === "global")) {
      return "it installs globally";
    }
    if (
      /^(pip|pip3|gem|cargo|go|brew)$/.test(base) &&
      (args.includes("--user") ||
        args.includes("-g") ||
        (base === "brew" && /^(install|uninstall|upgrade|remove|rm|tap)$/.test(args[0] ?? "")))
    ) {
      return "it installs globally";
    }
    if (base === "git" && args.includes("config") && args.includes("--global")) return "it changes the system";
    if (s.argv.some((a) => SECRET_PATH.test(a))) return "it touches secrets";
  }
  return null;
}

/**
 * What to do instead of a refused call, by `forbiddenReason`: the agent hears
 * why it was refused, so it changes the call instead of resending the same
 * one with another path (a heredoc refused three times in one run).
 */
const FORBIDDEN_HINTS: Record<string, string> = {
  "it can't be read plainly":
    "Commands are checked word by word, so heredocs (<<), $(…), backticks, variables, `FOO=1 cmd` and & jobs are never run here. Write or change files with the Edit and Write tools, then run plain commands one at a time.",
  "it writes outside the mission folder": "Write only inside your folder or /tmp.",
  "it changes files outside the mission folder": "Change files only inside your folder or /tmp.",
  "it runs other commands": "Run the commands themselves, one at a time, not through a shell, eval or xargs.",
  "it runs code given inline":
    "Code passed on the command line (node -e, python -c…) is never run without a person: write it to a file in your folder and run that file.",
  "it touches secrets": SECRET_MESSAGE,
};

export const forbiddenHint = (reason: string) => FORBIDDEN_HINTS[reason] ?? null;
