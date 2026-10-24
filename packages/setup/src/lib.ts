/**
 * The pure parts of the setup: options, .env editing, what Tailscale's status and Docker's errors mean,
 * the plan and the next steps. Everything that touches the disk, Docker or the terminal is in cli.ts.
 */
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { renderUnicodeCompact } from "uqr";

export const COMPOSE_URL = "https://raw.githubusercontent.com/agentes-chat/agentes-chat/main/docker-compose.yml";
export const GUIDE_URL = "https://github.com/agentes-chat/agentes-chat/blob/main/SELF_HOSTING.md";
export const ISSUES_URL = "https://github.com/agentes-chat/agentes-chat/issues";
export const IMAGE = "ghcr.io/agentes-chat/agentes:latest";
/** The compose file's Tailscale serve config is inline (`configs.content`), which Compose reads from 2.23.1 on. */
export const MIN_COMPOSE = "2.23.1";
export const DEFAULT_HOSTNAME = "agentes";
export const DEFAULT_TAG = "tag:agentes";
export const DEFAULT_TIMEOUT_S = 300;
export const DEFAULT_EMAIL_API_URL = "https://api.millionsend.com";
/** The names Compose looks for, in the order it prefers them: the setup reads the file Compose runs. */
export const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"] as const;

/** Tailscale admin console pages the steps send people to. */
export const TS = {
  signup: "https://login.tailscale.com/start",
  dns: "https://console.tailscale.com/admin/dns",
  keys: "https://console.tailscale.com/admin/settings/keys",
  machines: "https://console.tailscale.com/admin/machines",
  users: "https://console.tailscale.com/admin/users",
  policy: "https://console.tailscale.com/admin/acls",
  trust: "https://console.tailscale.com/admin/settings/trust-credentials",
  download: "https://tailscale.com/download",
} as const;

export const NETWORKS = ["tailscale", "domain", "local"] as const;
/** The ways in the setup sets up, or "proxy": a PUBLIC_URL of your own (nginx, a tunnel), which it keeps. */
export type Network = (typeof NETWORKS)[number] | "proxy";
export const EMAIL_CHOICES = ["skip", "smtp", "api"] as const;
export type EmailChoice = (typeof EMAIL_CHOICES)[number];

/** A check that failed, said so that a person or an agent can act on it. */
export interface Problem {
  check: string;
  error: string;
  fix: string;
}

// ── Options ─────────────────────────────────────────────────────────────────

export interface Options {
  network?: (typeof NETWORKS)[number];
  tailscaleKey?: string;
  tailscaleTag: string;
  hostname?: string;
  domain?: string;
  email?: EmailChoice;
  smtpUrl?: string;
  emailApiKey?: string;
  emailApiUrl?: string;
  emailFrom?: string;
  start: boolean;
  tailscaleStatus?: string;
  timeout: number;
  dryRun: boolean;
  json: boolean;
  help: boolean;
}

const OPTIONS = {
  network: { type: "string" },
  "tailscale-key": { type: "string" },
  "tailscale-tag": { type: "string" },
  hostname: { type: "string" },
  domain: { type: "string" },
  email: { type: "string" },
  "smtp-url": { type: "string" },
  "email-api-key": { type: "string" },
  "email-api-url": { type: "string" },
  "email-from": { type: "string" },
  "no-start": { type: "boolean" },
  "tailscale-status": { type: "string" },
  timeout: { type: "string" },
  "dry-run": { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

type OptionName = keyof typeof OPTIONS;

/** `tailscale-key` → `AGENTES_SETUP_TAILSCALE_KEY`: every option can come from the environment too. */
export const envName = (option: string) => `AGENTES_SETUP_${option.toUpperCase().replaceAll("-", "_")}`;

/** Flags first, then `AGENTES_SETUP_*` variables; every value checked the way a typed answer is. */
export function parseOptions(
  argv: string[],
  env: Record<string, string | undefined>,
): { options: Options } | { error: string } {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false }));
  } catch (error) {
    return { error: `${(error as Error).message}. Run with --help for the options.` };
  }
  const text = (name: OptionName): string | undefined => {
    const value = typeof values[name] === "string" ? (values[name] as string) : env[envName(name)];
    return value?.trim() || undefined;
  };
  const flag = (name: OptionName) => values[name] === true || /^(1|true|yes)$/i.test(env[envName(name)]?.trim() ?? "");

  const network = text("network");
  if (network !== undefined && !isOneOf(network, NETWORKS))
    return { error: "--network is tailscale, domain or local." };
  const email = text("email");
  if (email !== undefined && !isOneOf(email, EMAIL_CHOICES)) return { error: "--email is skip, smtp or api." };
  const timeoutText = text("timeout");
  const timeout = timeoutText === undefined ? DEFAULT_TIMEOUT_S : Number(timeoutText);
  if (!Number.isInteger(timeout) || timeout < 1) return { error: "--timeout is a number of seconds." };

  const checks: [OptionName, string | undefined, (value: string) => string | null][] = [
    ["tailscale-key", text("tailscale-key"), tailscaleKeyProblem],
    ["tailscale-tag", text("tailscale-tag"), tagProblem],
    ["hostname", text("hostname"), hostnameProblem],
    ["domain", text("domain"), (v) => domainProblem(normalizeDomain(v))],
    ["smtp-url", text("smtp-url"), smtpUrlProblem],
    ["email-api-url", text("email-api-url"), httpUrlProblem],
    ["email-from", text("email-from"), emailFromProblem],
  ];
  for (const [name, value, problem] of checks) {
    const found = value === undefined ? null : problem(value);
    if (found) return { error: `--${name}: ${found}` };
  }
  const domain = text("domain");
  return {
    options: {
      ...(network ? { network } : {}),
      ...optional("tailscaleKey", text("tailscale-key")),
      tailscaleTag: text("tailscale-tag") ?? DEFAULT_TAG,
      ...optional("hostname", text("hostname")),
      ...optional("domain", domain === undefined ? undefined : normalizeDomain(domain)),
      ...(email ? { email } : {}),
      ...optional("smtpUrl", text("smtp-url")),
      ...optional("emailApiKey", text("email-api-key")),
      ...optional("emailApiUrl", text("email-api-url")),
      ...optional("emailFrom", text("email-from")),
      start: !flag("no-start"),
      ...optional("tailscaleStatus", text("tailscale-status")),
      timeout,
      dryRun: flag("dry-run"),
      json: flag("json"),
      help: flag("help"),
    },
  };
}

const optional = <K extends string>(key: K, value: string | undefined) =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, string>>;

function isOneOf<T extends string>(value: string, list: readonly T[]): value is T {
  return (list as readonly string[]).includes(value);
}

/** A typed answer to a numbered list: its number, or the value itself (`2` or `domain`). */
export function resolveChoice<T extends string>(answer: string, values: readonly T[]): T | null {
  const typed = answer.trim().toLowerCase();
  const byNumber = /^\d+$/.test(typed) ? values[Number(typed) - 1] : undefined;
  return byNumber ?? (isOneOf(typed, values) ? typed : null);
}

// ── Answers ─────────────────────────────────────────────────────────────────

export function tailscaleKeyProblem(key: string): string | null {
  if (key.startsWith("tskey-api-")) {
    return "that's an API access token. Paste an auth key (tskey-auth-…) or an OAuth client secret (tskey-client-…).";
  }
  if (!/^tskey-(auth|client)-[A-Za-z0-9-]{8,}(\?[A-Za-z0-9=&]+)?$/.test(key)) {
    return "that isn't a Tailscale auth key: one starts with tskey-auth- (or tskey-client- for an OAuth client secret) and has no spaces.";
  }
  return null;
}

export const tagProblem = (tag: string) =>
  /^tag:[A-Za-z0-9][A-Za-z0-9-]*$/.test(tag) ? null : "a tag looks like tag:agentes.";

export const hostnameProblem = (name: string) =>
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)
    ? null
    : "a device name has lowercase letters, digits and dashes, like agentes.";

/** "https://Chat.Example.com/" → "chat.example.com": people paste addresses as often as names. */
export const normalizeDomain = (input: string) =>
  input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "");

export function domainProblem(domain: string): string | null {
  if (domain.endsWith(".ts.net")) return "a ts.net name comes from Tailscale: choose Tailscale instead.";
  if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/.test(domain)) {
    return "that isn't a domain name like chat.example.com.";
  }
  return null;
}

export function smtpUrlProblem(url: string): string | null {
  const parsed = parseUrl(url);
  return parsed && (parsed.protocol === "smtp:" || parsed.protocol === "smtps:") && parsed.hostname
    ? null
    : "that isn't an SMTP URL like smtps://user:password@smtp.example.com:465 (percent-encode special characters in the user and password).";
}

export function httpUrlProblem(url: string): string | null {
  const parsed = parseUrl(url);
  return parsed && (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname
    ? null
    : "that isn't an address like https://api.resend.com.";
}

/** The shapes `EMAIL_FROM` takes: a bare address, or `Name <address>`. */
export const emailFromProblem = (from: string) =>
  /^(?:[^<>]+<)?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?$/.test(from)
    ? null
    : 'that isn\'t a sender like "agentes <ola@example.com>".';

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

// ── .env ────────────────────────────────────────────────────────────────────

/** The top of a .env the setup creates. */
export const ENV_HEADER = `# agentes.chat settings, written by npx @agenteschat/setup (running it again is safe). Every
# value is explained in SELF_HOSTING.md. AGENTES_SECRET encrypts the keys stored in the database:
# back it up apart from the database, and never change it.
`;

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/**
 * The value of `KEY=` as Compose reads it: the last line wins, as in `cp .env.example .env` followed by
 * appended values. Null when the line is absent, "" when it is empty.
 */
export function envValue(content: string | null, key: string): string | null {
  let value: string | null = null;
  for (const line of content?.split("\n") ?? []) {
    const match = ENV_LINE.exec(line);
    if (match?.[1] === key) value = unquoteEnvValue((match[2] ?? "").trim());
  }
  return value;
}

/**
 * Rewrites a key where it first appears, drops its other lines so the new value is the one Compose
 * reads, and appends the keys the file lacks. Comments and every other line stay as they are.
 */
export function upsertEnv(content: string, entries: Record<string, string>): string {
  const wanted = new Map(Object.entries(entries));
  const written = new Set<string>();
  const lines: string[] = [];
  for (const line of content.split("\n")) {
    const key = ENV_LINE.exec(line)?.[1];
    const value = key === undefined ? undefined : wanted.get(key);
    if (key === undefined || value === undefined) lines.push(line);
    else if (!written.has(key)) {
      written.add(key);
      lines.push(`${key}=${quoteEnvValue(value)}`);
    }
  }
  const missing = [...wanted].filter(([key]) => !written.has(key));
  if (missing.length > 0) {
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    for (const [key, value] of missing) lines.push(`${key}=${quoteEnvValue(value)}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * A value Compose reads back unchanged: as is when it has only plain characters, else in single quotes
 * (nothing is interpolated inside them), else double quotes. A line break would start a new key.
 */
export function quoteEnvValue(value: string): string {
  const flat = value.replace(/[\r\n]/g, "");
  if (/^[\w@%+=:,./-]*$/.test(flat)) return flat;
  if (!flat.includes("'")) return `'${flat}'`;
  // ponytail: a "$" inside double quotes is left for Compose to interpolate; no value the setup writes has both quote kinds.
  return `"${flat.replace(/[\\"]/g, "\\$&")}"`;
}

export function unquoteEnvValue(raw: string): string {
  const quote = raw[0];
  if ((quote === "'" || quote === '"') && raw.length >= 2 && raw.endsWith(quote)) {
    const inner = raw.slice(1, -1);
    return quote === '"' ? inner.replace(/\\([\\"])/g, "$1") : inner;
  }
  // Unquoted, " #" starts a comment.
  return raw.replace(/\s+#.*$/, "");
}

const list = (value: string | null) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

/** How a .env says people reach the instance; null for a .env that says nothing yet. */
export function networkOf(content: string | null): Network | null {
  const profiles = list(envValue(content, "COMPOSE_PROFILES"));
  if (profiles.includes("tailscale")) return "tailscale";
  if (profiles.includes("https") || envValue(content, "DOMAIN")) return "domain";
  const url = envValue(content, "PUBLIC_URL");
  return !url ? null : isLocalUrl(url) ? "local" : "proxy";
}

type Profile = "tailscale" | "https" | null;

/**
 * What a run writes about the way in before anything starts: the .env lines (PUBLIC_URL only when it
 * changes) and the profile in COMPOSE_PROFILES. Tailscale's address is written once it has joined, a
 * public domain stays on localhost without Caddy until its owner exists (the first sign-up owns the
 * instance), and your own proxy's address is kept.
 */
export function wayIn(
  content: string | null,
  network: Network,
  domain: string | null,
): { entries: Record<string, string>; profile: Profile } {
  const now = envValue(content, "PUBLIC_URL");
  const local = `http://localhost:${envValue(content, "HOST_PORT") || "3000"}`;
  if (network === "domain") {
    const live = now === `https://${domain}`;
    return {
      entries: { ...(domain ? { DOMAIN: domain } : {}), ...(live || now === local ? {} : { PUBLIC_URL: local }) },
      profile: live ? "https" : null,
    };
  }
  // A DOMAIN left behind would take the next run back to the public domain.
  const entries: Record<string, string> = envValue(content, "DOMAIN") ? { DOMAIN: "" } : {};
  if (network === "local" && !isLocalUrl(now)) entries.PUBLIC_URL = local;
  return { entries, profile: network === "tailscale" ? "tailscale" : null };
}

/**
 * The command that removes the containers of a way in the .env drops: `docker compose up` leaves a
 * service of a disabled profile running, so a switch to Tailscale would keep Caddy serving the public
 * domain. Null when nothing is dropped.
 */
export function stopCommand(content: string | null, profile: Profile): string[] | null {
  const enabled = list(envValue(content, "COMPOSE_PROFILES"));
  const off = (["tailscale", "https"] as const).filter((name) => name !== profile && enabled.includes(name));
  if (off.length === 0) return null;
  const service = { tailscale: "tailscale", https: "caddy" };
  return ["compose", ...off.flatMap((name) => ["--profile", name]), "rm", "-sf", ...off.map((name) => service[name])];
}

/**
 * `COMPOSE_PROFILES` with one way in: `tailscale`, `https` (Caddy) or neither. Other profiles stay. The
 * content comes back unchanged when the profiles already match.
 */
export function withNetworkProfile(content: string, profile: Profile): string {
  const current = list(envValue(content, "COMPOSE_PROFILES"));
  const next = [...current.filter((p) => p !== "tailscale" && p !== "https"), ...(profile ? [profile] : [])];
  return next.join(",") === current.join(",") ? content : upsertEnv(content, { COMPOSE_PROFILES: next.join(",") });
}

/** What the compose file needs and the .env lacks: the master secret and the database password. */
export function secretEntries(content: string | null): Record<string, string> {
  return {
    ...(envValue(content, "AGENTES_SECRET") ? {} : { AGENTES_SECRET: randomBytes(48).toString("base64") }),
    // Hex: the compose file puts it inside the database URL.
    ...(envValue(content, "POSTGRES_PASSWORD") ? {} : { POSTGRES_PASSWORD: randomBytes(24).toString("hex") }),
  };
}

/**
 * The .env lines for a pasted key. An OAuth client secret registers a tagged device that stays (not
 * ephemeral) and needs no approval; the tag must be one the OAuth client was created with.
 */
export function tailscaleKeyEntries(key: string, tag: string, extraArgs: string | null): Record<string, string> {
  if (!key.startsWith("tskey-client-")) return { TS_AUTHKEY: key };
  const args = (extraArgs ?? "").split(/\s+/).filter((arg) => arg && !arg.startsWith("--advertise-tags"));
  return {
    TS_AUTHKEY: key.includes("?") ? key : `${key}?ephemeral=false&preauthorized=true`,
    TS_EXTRA_ARGS: [...args, `--advertise-tags=${tag}`].join(" "),
  };
}

export const isTailnetUrl = (url: string | null) => /^https:\/\/[^/]+\.ts\.net\/?$/i.test(url ?? "");

export const isLocalUrl = (url: string | null) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(url ?? "");

// ── Tailscale ───────────────────────────────────────────────────────────────

/** A tailnet setting's fix doesn't say "run the setup again": on a terminal, the setup waits for the click. */
export const PROBLEMS = {
  magicDns: {
    check: "tailscale.magicdns",
    error: "MagicDNS is off in your tailnet, so devices can't find this server by name.",
    fix: `Open ${TS.dns} and click "Enable MagicDNS".`,
  },
  https: {
    check: "tailscale.https",
    error: "HTTPS certificates are off in your tailnet.",
    fix: `Open ${TS.dns}, under "HTTPS Certificates" click "Enable HTTPS" and confirm.`,
  },
  key: {
    check: "tailscale.key",
    error: "Tailscale refused the auth key: it expired, was revoked, or was a one-off key that's already used.",
    fix: `Generate a new one at ${TS.keys} ("Generate auth key"), then run the setup again with it.`,
  },
  keyMissing: {
    check: "tailscale.key",
    error: "Tailscale needs an auth key to add this server to your tailnet.",
    fix: `Generate one at ${TS.keys} ("Generate auth key") and pass it: --tailscale-key tskey-auth-… (or AGENTES_SETUP_TAILSCALE_KEY).`,
  },
  approval: {
    check: "tailscale.approval",
    error: "This server is waiting for approval in your tailnet.",
    fix: `Open ${TS.machines}, find the server marked "Needs approval", and choose Approve in its … menu. A pre-approved auth key skips this.`,
  },
} satisfies Record<string, Problem>;

export const tagProblemFor = (tag: string): Problem => ({
  check: "tailscale.tag",
  error: `Tailscale refused the tag ${tag} for this key.`,
  fix: `Pass the tag the OAuth client was created with (--tailscale-tag), and list it under "tagOwners" in ${TS.policy}.`,
});

export type TailnetState =
  | { kind: "ready"; url: string; keyExpiry: string | null }
  | { kind: "waiting"; reason: "starting" | "approval" | "login" }
  | { kind: "problem"; problem: Problem };

/** What `tailscale status --json` says: on the tailnet with HTTPS (and the address), still on its way, or why not. */
export function readTailscaleStatus(raw: string): TailnetState {
  let status: {
    BackendState?: unknown;
    CurrentTailnet?: { MagicDNSEnabled?: unknown } | null;
    CertDomains?: unknown;
    Self?: { KeyExpiry?: unknown } | null;
  };
  try {
    status = JSON.parse(raw);
  } catch {
    return { kind: "waiting", reason: "starting" };
  }
  if (status.BackendState === "NeedsMachineAuth") return { kind: "waiting", reason: "approval" };
  if (status.BackendState === "NeedsLogin") return { kind: "waiting", reason: "login" };
  if (status.BackendState !== "Running") return { kind: "waiting", reason: "starting" };
  if (status.CurrentTailnet?.MagicDNSEnabled === false) return { kind: "problem", problem: PROBLEMS.magicDns };
  const domain = Array.isArray(status.CertDomains) ? status.CertDomains[0] : undefined;
  if (typeof domain !== "string" || !domain) return { kind: "problem", problem: PROBLEMS.https };
  const expiry = status.Self?.KeyExpiry;
  return { kind: "ready", url: `https://${domain}`, keyExpiry: typeof expiry === "string" ? expiry : null };
}

/** The latest thing the tailscale container's log says went wrong, or that it waits for approval. */
export function diagnoseTailscaleLogs(logs: string, tag: string): Problem | "approval" | null {
  for (const line of logs.split("\n").reverse()) {
    if (/invalid key|unable to validate API key|key (has )?expired/i.test(line)) return PROBLEMS.key;
    if (/tags?\b.*\b(invalid|not permitted)/i.test(line)) return tagProblemFor(tag);
    if (/machine authorization required/i.test(line)) return "approval";
    if (/ensure that HTTPS is enabled|HTTPS cert support is not enabled/i.test(line)) return PROBLEMS.https;
  }
  return null;
}

// ── Docker ──────────────────────────────────────────────────────────────────

/** `2.29.7`, `v2.29.7-desktop.1` and the like, compared by their first three numbers. */
export function versionAtLeast(version: string, min: string): boolean {
  const parse = (v: string) => /(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number) ?? null;
  const [have, need] = [parse(version), parse(min)];
  if (!have || !need) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i] !== need[i]) return (have[i] ?? 0) > (need[i] ?? 0);
  }
  return true;
}

export type Platform = "linux" | "darwin" | "win32" | string;

const desktopUrl = (platform: Platform) =>
  platform === "win32"
    ? "https://docs.docker.com/desktop/setup/install/windows-install/"
    : "https://docs.docker.com/desktop/setup/install/mac-install/";

export const dockerProblems = (platform: Platform) => ({
  missing: {
    check: "docker",
    error: "Docker isn't installed.",
    fix:
      platform === "linux"
        ? "Install it with Docker's script, curl -fsSL https://get.docker.com | sudo sh, then run the setup again."
        : `Install Docker Desktop (${desktopUrl(platform)}), open it, then run the setup again.`,
  },
  compose: {
    check: "docker.compose",
    error: "Docker Compose v2 (docker compose) isn't installed.",
    fix:
      platform === "linux"
        ? "Install it with Docker's script, curl -fsSL https://get.docker.com | sudo sh (it includes Compose), or see https://docs.docker.com/compose/install/linux/. Then run the setup again."
        : "Update Docker Desktop, which includes Compose, then run the setup again.",
  },
  composeOld: (version: string): Problem => ({
    check: "docker.compose",
    error: `Docker Compose ${version} is too old: this compose file needs ${MIN_COMPOSE} or newer.`,
    fix:
      platform === "linux"
        ? "Update Docker (on Debian or Ubuntu with Docker's repository: sudo apt-get update && sudo apt-get install docker-compose-plugin), then run the setup again."
        : "Update Docker Desktop, then run the setup again.",
  }),
  down: {
    check: "docker.daemon",
    error: "Docker is installed but not running.",
    fix:
      platform === "linux"
        ? "Start it with sudo systemctl start docker, then run the setup again."
        : "Open Docker Desktop and wait until it says it's running, then run the setup again.",
  },
  permission: {
    check: "docker.permission",
    error: "Your user can't use Docker (permission denied on /var/run/docker.sock).",
    fix: "Add yourself to the docker group, sudo usermod -aG docker $USER, log out and back in, then run the setup again.",
  },
});

/** Why `docker version` failed: not running, or not allowed. */
export function diagnoseDocker(output: string, platform: Platform): Problem {
  const problems = dockerProblems(platform);
  return /permission denied/i.test(output) ? problems.permission : problems.down;
}

/** A `docker compose` failure people hit often, said with its fix; null for anything else. */
export function diagnoseCompose(output: string, platform: Platform): Problem | null {
  const busy = output.split("\n").find((line) => /port is already allocated|address already in use/i.test(line));
  if (busy !== undefined) {
    const port = /:(\d{2,5})(?!\d)/.exec(busy)?.[1] ?? "3000";
    const who = platform === "darwin" ? `lsof -nP -iTCP:${port} -sTCP:LISTEN` : `sudo ss -ltnp 'sport = :${port}'`;
    return port === "80" || port === "443"
      ? {
          check: "port",
          error: `Port ${port} on this machine is in use by another program, and a public domain needs ports 80 and 443.`,
          fix: `Stop that program (${who} shows which), then run the setup again.`,
        }
      : {
          check: "port",
          error: `Port ${port} on this machine is in use by another program.`,
          fix: `Set HOST_PORT to a free port in .env (HOST_PORT=3001), or stop that program (${who} shows which), then run the setup again.`,
        };
  }
  if (/permission denied[^\n]*docker\.sock/i.test(output)) return dockerProblems(platform).permission;
  if (/Cannot connect to the Docker daemon/i.test(output)) return dockerProblems(platform).down;
  if (/no space left on device/i.test(output)) {
    return {
      check: "disk",
      error: "This machine is out of disk space.",
      fix: "Free some space (docker system prune removes unused images), then run the setup again.",
    };
  }
  return null;
}

/** The lines after "Invalid configuration" in the app's log (read without Compose's prefix): what to fix in .env. */
export function diagnoseAppLogs(logs: string): Problem | null {
  const at = logs.lastIndexOf("Invalid configuration");
  if (at < 0) return null;
  const issues = [...logs.slice(at).matchAll(/^\s+- (.+)$/gm)].map((m) => (m[1] ?? "").trim()).slice(0, 5);
  return {
    check: "app.config",
    error: `The app refused its configuration${issues.length ? `: ${issues.join("; ")}` : ""}.`,
    fix: "Fix those values in .env, then run the setup again. docker compose logs agentes shows the whole message.",
  };
}

// ── The end ─────────────────────────────────────────────────────────────────

/**
 * The link the phone app opens on this server; the web app's "Abrir no celular" adds `&token=` for a
 * one-time sign-in. SELF_HOSTING.md, "Your phone".
 */
export const phoneLink = (origin: string) => `agenteschat://connect?${new URLSearchParams({ server: origin })}`;

/** A QR code in half blocks, light modules drawn: on a terminal it needs light on dark (cli.ts sets the colors). */
export const qrCode = (text: string) => renderUnicodeCompact(text, { border: 2 });

export interface PlanInput {
  /** "Docker 27.3.1 with Compose 2.29.7", or what's wrong and its fix. Null: not checked (inside the image). */
  docker: string | null;
  /** What a run without --dry-run asks, when nothing else answers it. */
  questions: string[];
  envExists: boolean;
  newSecrets: string[];
  network: Network;
  /** PUBLIC_URL in .env now, and what the run writes before starting (null: unchanged). */
  publicUrl: { now: string | null; next: string | null };
  /** stopCommand's: the containers of the way in the run drops. */
  stop: string[] | null;
  hostname: string;
  /** Where the Tailscale key comes from. */
  tailscale: "given" | "env" | "joined" | "ask" | "missing";
  domain: string | null;
  email: EmailChoice | "set";
  compose: string | null;
  start: boolean;
  image: boolean;
}

/** What the setup is about to do, step by step: the --dry-run output and the live run say the same. */
export function planSteps(p: PlanInput): string[] {
  const steps: string[] = [];
  steps.push(p.docker ?? "Docker: not checked here (setup inside the image)");
  if (p.questions.length) steps.push(`asks: ${p.questions.join("; ")}`);
  steps.push(
    p.envExists
      ? `.env: keep it and add only what's missing${p.newSecrets.length ? ` (${p.newSecrets.join(", ")})` : ""}`
      : `.env: create it, readable by you only, with ${p.newSecrets.join(" and ")} generated`,
  );
  if (p.network === "tailscale") {
    steps.push(`network: Tailscale, COMPOSE_PROFILES=tailscale, device name ${p.hostname}`);
    steps.push(
      {
        given: "Tailscale: join the tailnet with the key given",
        env: "Tailscale: join the tailnet with the key in .env",
        joined: "Tailscale: already on the tailnet, no key needed",
        ask: "Tailscale: show the admin console steps and ask for an auth key",
        missing: "Tailscale: stop, an auth key is needed (--tailscale-key)",
      }[p.tailscale],
    );
  } else if (p.network === "domain") {
    steps.push(`network: public domain ${p.domain ?? "(asked)"}, HTTPS by Caddy on ports 80 and 443`);
  } else if (p.network === "proxy") {
    steps.push(`network: your own proxy or tunnel at ${p.publicUrl.now}; PUBLIC_URL and COMPOSE_PROFILES stay`);
  } else {
    steps.push("network: this machine only, http://localhost");
  }
  if (p.publicUrl.next) {
    steps.push(`PUBLIC_URL: ${p.publicUrl.next}${p.publicUrl.now ? `, replacing ${p.publicUrl.now}` : ""}`);
  }
  steps.push(
    {
      skip: "email: none for now (set SMTP_URL or MILLIONSEND_API_KEY later)",
      smtp: "email: an SMTP server",
      api: "email: a Resend-compatible API",
      set: "email: keep what .env has",
    }[p.email],
  );
  steps.push(p.compose ? `compose: use ${p.compose}` : `compose: download docker-compose.yml from ${COMPOSE_URL}`);
  if (p.image || !p.start) {
    steps.push("start: print the commands to run (docker compose up -d) and how to finish");
    return steps;
  }
  if (p.stop) steps.push(`stop: docker ${p.stop.join(" ")}, the way in it no longer uses`);
  if (p.network === "tailscale") {
    steps.push("start: docker compose up -d tailscale, wait until it's on the tailnet with HTTPS");
    steps.push("PUBLIC_URL: write the address Tailscale gives it (https://<device>.<tailnet>.ts.net)");
    steps.push("start: docker compose up -d, wait for the HTTPS certificate and /api/health");
  } else if (p.network === "domain" && p.publicUrl.now === `https://${p.domain}`) {
    steps.push(`start: docker compose up -d, wait for https://${p.domain}`);
  } else if (p.network === "domain") {
    steps.push("start: docker compose up -d on localhost first, wait for /api/health");
    steps.push("owner: wait for the first account (through an SSH tunnel), so nobody else can take the instance");
    steps.push("PUBLIC_URL: https://<domain>, COMPOSE_PROFILES=https, then wait for the certificate");
  } else {
    steps.push("start: docker compose up -d, wait for /api/health");
  }
  steps.push("finish: the address, a QR code for the phone app, and what to do next");
  return steps;
}

/** What the person does once the setup is done. */
export function nextSteps(p: {
  network: Network;
  url: string;
  firstRun: boolean | null;
  keyExpiry: string | null;
}): string[] {
  const steps: string[] = [];
  const account = p.firstRun === false ? "sign in" : "create your account: the first one owns this instance";
  if (p.network === "tailscale") {
    steps.push(`On a computer or phone signed in to your tailnet, open ${p.url} and ${account}.`);
    steps.push(
      `Phone: install Tailscale (${TS.download}), sign in to your tailnet, and install the agentes.chat app. Then point the camera at the QR code above, or on the app's sign-in screen tap "Change" next to the server ("Trocar" in Portuguese), then "Scan QR code".`,
    );
    steps.push(
      `People you invite need your tailnet too: invite them to it (${TS.users}, "Invite users"), or share this server with theirs (its … menu in ${TS.machines}, "Share").`,
    );
    if (p.keyExpiry) {
      steps.push(
        `In ${TS.machines}, open this server's … menu and choose "Disable Key Expiry", or it leaves your tailnet on ${p.keyExpiry.slice(0, 10)}.`,
      );
    }
  } else if (p.network === "domain" || p.network === "proxy") {
    steps.push(`Open ${p.url} and ${account}.`);
    steps.push(
      `Phone: point the camera at the QR code above, or on the agentes.chat app's sign-in screen tap "Change" next to the server ("Trocar" in Portuguese), then "Scan QR code".`,
    );
  } else {
    const port = new URL(p.url).port || "80";
    steps.push(`Open ${p.url} and ${account}.`);
    steps.push(
      `On a server, open it from your computer through an SSH tunnel: ssh -L ${port}:localhost:${port} you@your-server`,
    );
  }
  return steps;
}
