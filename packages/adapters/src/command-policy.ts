import path from "node:path";
import { ruleMatches } from "./machine-protocol";

/**
 * Deterministic command policy for mission work turns (ADR 0029). No model:
 * plain parsing of the shell line Claude Code wants to run.
 *
 * - `readOnlyCall`: harmless reads (listing and reading files anywhere but
 *   secrets, read-only git, GET/HEAD fetches that save only into the
 *   mission folder). The runner's prompt tool allows these at once, with no
 *   card and nothing posted.
 * - `forbiddenReason`: what code never lets the judge approve (sudo, deletes
 *   and writes outside the mission folder, system services, uploads, remote
 *   shells, global installs, anything it can't read plainly). The judge only
 *   classifies what is left; the deny list stays first and hard.
 *
 * Anything this can't parse with certainty is "not read-only" (a card).
 */

export interface CommandScope {
  /** Where the task runs (relative paths resolve here). */
  cwd: string;
  /** The mission folder and the task's own folder: writes are allowed inside. */
  folders: string[];
  /** The person's home, for `~`. */
  home?: string;
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

/** Secrets a read never gets without a person: keys, tokens, env files, the runner's own home. */
const SECRET_PATH =
  /(^|\/)(\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.azure|\.gcloud|\.password-store|Keychains|\.agentes-runner)(\/|$)|(^|\/)\.config\/(gh|gcloud)(\/|$)|(^|\/)(\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.pgpass|\.env(\.[\w.-]+)?|id_[a-z0-9]+(\.pub)?|credentials(\.json)?|.*\.pem|.*\.key|mcp-token)$/i;

function secretPath(scope: CommandScope, p: string) {
  const r = resolveIn(scope, p);
  return r === null || SECRET_PATH.test(r) || SECRET_PATH.test(p);
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

function readOnlySimple(s: Simple, scope: CommandScope): boolean {
  const [cmd, ...args] = s.argv;
  if (!cmd) return false;
  if (s.writes.some((w) => !insideFolders(scope, w))) return false;
  if (s.reads.some((r) => secretPath(scope, r))) return false;
  // Nothing that reads a secret, wherever it is named.
  const pathArgs = args.filter((a) => !a.startsWith("-"));
  if (
    pathArgs.some((a) => SECRET_PATH.test(a) || (a.startsWith("/") || a.startsWith("~") ? secretPath(scope, a) : false))
  ) {
    return false;
  }
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
      return readOnlyGit(s.argv) || fetchIntoFolders(s.argv, scope);
    case "curl":
      return readOnlyCurl(s.argv, scope);
    case "wget":
      return readOnlyWget(s.argv, scope);
    default:
      return false;
  }
}

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);

/**
 * A call that only reads (or fetches into the mission folder): allowed at
 * once, no card. Every part of a pipeline or list must be read-only, so
 * `curl … | sh` or `ls | xargs rm` never pass.
 */
export function readOnlyCall(toolName: string, input: Record<string, unknown> | null | undefined, scope: CommandScope) {
  const i = input ?? {};
  if (READ_TOOLS.has(toolName)) {
    const p = [i.file_path, i.path].find((v): v is string => typeof v === "string");
    return !p || !secretPath(scope, p);
  }
  if (toolName !== "Bash") return false;
  const command = typeof i.command === "string" ? i.command : "";
  if (!command.trim() || command.length > 2000) return false;
  const cmds = simpleCommands(command);
  return Boolean(cmds && cmds.length > 0 && cmds.every((s) => readOnlySimple(s, scope)));
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
];

/** On the deny list: refused at once, never shown to anyone, never judged. */
export const deniedInMissions = (toolName: string, input: Record<string, unknown> | null | undefined) =>
  MISSION_DENY_RULES.some((rule) => ruleMatches(rule, toolName, input));

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

/**
 * Why code refuses a call even when the judge would allow it (null: the
 * judge may decide). Applies to Bash; other tools have no such rules.
 */
export function forbiddenReason(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
  scope: CommandScope,
): string | null {
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
};

export const forbiddenHint = (reason: string) => FORBIDDEN_HINTS[reason] ?? null;
