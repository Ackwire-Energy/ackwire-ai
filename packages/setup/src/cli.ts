/**
 * `npx @agenteschat/setup`: from an empty directory to a running agentes.chat, on a tailnet by default.
 * Inside the app image (`docker run … agentes setup`) there is no Docker to drive, so it prepares the
 * directory and prints the commands that finish the job.
 */
import { spawn, spawnSync } from "node:child_process";
import type { EventEmitter } from "node:events";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  COMPOSE_FILES,
  COMPOSE_URL,
  DEFAULT_EMAIL_API_URL,
  DEFAULT_HOSTNAME,
  diagnoseAppLogs,
  diagnoseCompose,
  diagnoseDocker,
  diagnoseTailscaleLogs,
  dockerProblems,
  domainProblem,
  type EmailChoice,
  ENV_HEADER,
  emailFromProblem,
  envName,
  envValue,
  GUIDE_URL,
  httpUrlProblem,
  IMAGE,
  ISSUES_URL,
  isTailnetUrl,
  MIN_COMPOSE,
  type Network,
  networkOf,
  nextSteps,
  normalizeDomain,
  type Options,
  PROBLEMS,
  type Problem,
  parseOptions,
  phoneLink,
  planSteps,
  qrCode,
  readTailscaleStatus,
  resolveChoice,
  secretEntries,
  smtpUrlProblem,
  stopCommand,
  TS,
  tailscaleKeyEntries,
  tailscaleKeyProblem,
  upsertEnv,
  versionAtLeast,
  wayIn,
  withNetworkProfile,
} from "./lib";

const HELP = `agentes.chat setup: a self-hosted agentes.chat with Docker, in the current directory.

Usage: npx @agenteschat/setup [options]

It asks only for what it needs and fills in only what's missing, so running it again is safe.

  --network <tailscale|domain|local>  How people reach it. tailscale (the default): private HTTPS on
                                      your tailnet, no domain or open port. domain: a public domain with
                                      Caddy on ports 80 and 443. local: http://localhost on this machine.
                                      Without it, a PUBLIC_URL of your own in .env (nginx, a tunnel)
                                      stays as it is.
  --tailscale-key <key>               Auth key (tskey-auth-…) or OAuth client secret (tskey-client-…)
  --tailscale-tag <tag:name>          The tag for an OAuth client secret (default tag:agentes)
  --hostname <name>                   The server's name on the tailnet (default agentes)
  --domain <host>                     The public domain, with --network domain
  --email <skip|smtp|api>             Email for invitations and password resets (default skip)
  --smtp-url <url>                    smtps://user:password@smtp.example.com:465
  --email-api-key <key>               Key of a Resend-compatible API (MillionSend, Resend)
  --email-api-url <url>               That API's address (default ${DEFAULT_EMAIL_API_URL})
  --email-from <sender>               "agentes <ola@example.com>"
  --no-start                          Write .env and docker-compose.yml, start nothing
  --timeout <seconds>                 How long each wait may take (default 300)
  --tailscale-status <file|->         Finish from \`tailscale status --json\` (setup inside the image)
  --dry-run                           Print the plan and change nothing
  --json                              No questions; the result as JSON on stdout, progress on stderr
  -h, --help

Every option can come from the environment too: AGENTES_SETUP_<OPTION>, like
AGENTES_SETUP_TAILSCALE_KEY=tskey-auth-… Without a terminal, answers are read one per line from
stdin, and an empty line or the end of the input takes the default.

Guide: ${GUIDE_URL}`;

class SetupError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.error);
  }
}

type Result = { ok: boolean } & Record<string, unknown>;

type App = { health: { status?: string; version?: string } & Record<string, unknown>; firstRun: boolean };

export async function main(argv: string[], context: { image?: boolean } = {}): Promise<number> {
  const parsed = parseOptions(argv, process.env);
  if ("error" in parsed) {
    if (argv.includes("--json") || /^(1|true|yes)$/i.test(process.env[envName("json")]?.trim() ?? "")) {
      const result = { ok: false, check: "options", error: parsed.error, fix: "Run with --help for the options." };
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else console.error(parsed.error);
    return 2;
  }
  const opts = parsed.options;
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  const ui = createUi(opts);
  let result: Result;
  try {
    result = await run(opts, ui, context.image === true);
  } catch (error) {
    // Anything unforeseen still ends as a check and a fix, so --json always answers.
    const problem =
      error instanceof SetupError
        ? error.problem
        : {
            check: "unexpected",
            error: (error as Error)?.message ?? String(error),
            fix: `Run it again. If it fails the same way, open an issue with this output: ${ISSUES_URL}`,
          };
    ui.fail(problem);
    result = { ok: false, ...problem };
  } finally {
    ui.close();
  }
  if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

// ── Terminal ────────────────────────────────────────────────────────────────

type Ui = ReturnType<typeof createUi>;

interface AskOptions {
  initial?: string;
  /** Echoed cut short when stdin is piped. */
  secret?: boolean;
  /** Without an answer: asked again on a terminal, this problem when piped. */
  missing?: Problem;
  validate?: (value: string) => string | null;
}

function createUi(opts: Options) {
  // With --json, stdout is for the result alone.
  const stream = opts.json ? process.stderr : process.stdout;
  const tty = stream.isTTY === true;
  const color = tty && !process.env.NO_COLOR;
  const paint = (code: string) => (text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const bold = paint("1");
  const dim = paint("2");
  const interactive = !opts.json && tty && process.stdin.isTTY === true;
  const write = (text = "") => stream.write(`${text}\n`);

  let reader: ReturnType<typeof createInterface> | undefined;
  let lines: AsyncIterator<string> | undefined;
  const readLine = async (): Promise<string | null> => {
    if (!lines) {
      reader = createInterface({ input: process.stdin, terminal: false });
      lines = reader[Symbol.asyncIterator]();
    }
    const next = await lines.next();
    return next.done ? null : next.value;
  };

  const ui = {
    stream,
    dim,
    interactive,
    /** Answers come from a terminal or from piped lines; never with --json, and not from a piped `tailscale status`. */
    canAsk: !opts.json && !opts.dryRun && opts.tailscaleStatus !== "-",
    write,
    title: (text: string) => write(`\n${bold(text)}`),
    note: (text: string) => write(dim(text)),
    ok: (text: string) => write(`${paint("32")("✓")} ${text}`),
    warn: (text: string) => write(`${paint("33")("!")} ${text}`),
    fail(problem: Problem) {
      write(`${paint("31")("✗")} ${problem.error}`);
      write(`  ${problem.fix}`);
    },
    list(title: string, items: string[], numbered = false) {
      write(`\n${bold(title)}`);
      for (const [i, item] of items.entries()) write(`  ${numbered ? `${i + 1}.` : "·"} ${item}`);
    },
    qr(text: string) {
      // Light modules drawn on a forced dark background: right on dark and light terminals alike.
      for (const line of qrCode(text).split("\n")) write(color ? `  \x1b[97;40m${line}\x1b[0m` : `  ${line}`);
    },
    /** An answer; empty takes `initial`. Piped, a bad answer stops the setup: nobody is there to ask again. */
    async ask(question: string, o: AskOptions = {}): Promise<string> {
      for (;;) {
        stream.write(`${question}${o.initial ? dim(` [${o.initial}]`) : ""}: `);
        const line = await readLine();
        if (!interactive) write(line && o.secret ? `${line.slice(0, 12)}…` : (line ?? ""));
        const answer = (line ?? "").trim() || o.initial || "";
        const problem = answer ? (o.validate?.(answer) ?? null) : o.missing ? "an answer is needed." : null;
        if (!problem) return answer;
        if (!interactive || line === null) {
          throw new SetupError(
            !answer && o.missing
              ? o.missing
              : { check: "answer", error: `${question}: ${problem}`, fix: "Run with --help for the options." },
          );
        }
        ui.warn(problem.charAt(0).toUpperCase() + problem.slice(1));
      }
    },
    async choose<T extends string>(title: string, items: { value: T; label: string }[], initial: T): Promise<T> {
      ui.list(
        title,
        items.map((item) => item.label),
        true,
      );
      const values = items.map((item) => item.value);
      const answer = await ui.ask("Choose", {
        initial: String(values.indexOf(initial) + 1),
        validate: (v) => (resolveChoice(v, values) ? null : `type a number from 1 to ${items.length}.`),
      });
      return resolveChoice(answer, values) ?? initial;
    },
    close: () => reader?.close(),
  };
  return ui;
}

// ── Docker ──────────────────────────────────────────────────────────────────

function docker(args: string[], timeoutMs?: number) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT")
    return { code: -1, stdout: "", stderr: "" };
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function checkDocker(): { label: string } | { problem: Problem } {
  const problems = dockerProblems(process.platform);
  const server = docker(["version", "--format", "{{.Server.Version}}"]);
  if (server.code === -1) return { problem: problems.missing };
  if (server.code !== 0) return { problem: diagnoseDocker(server.stderr, process.platform) };
  const compose = docker(["compose", "version", "--short"]);
  if (compose.code !== 0) return { problem: problems.compose };
  const version = compose.stdout.trim().replace(/^v/, "");
  if (!versionAtLeast(version, MIN_COMPOSE)) return { problem: problems.composeOld(version) };
  return { label: `Docker ${server.stdout.trim()} with Compose ${version}` };
}

/** `docker compose up -d`, its output shown as it comes and kept for `diagnoseCompose`. */
function composeUp(ui: Ui, services: string[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["compose", "up", "-d", "--quiet-pull", ...services], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const forward = (chunk: Buffer) => {
      output += chunk.toString();
      ui.stream.write(ui.dim(chunk.toString()));
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    const events = child as unknown as EventEmitter;
    events.on("error", (error: Error) =>
      reject(new SetupError({ check: "docker", error: error.message, fix: "Run the setup again." })),
    );
    events.on("close", (code: number | null) => {
      if (code === 0) return resolve();
      const last = output.trim().split("\n").pop() ?? "";
      reject(
        new SetupError(
          diagnoseCompose(output, process.platform) ?? {
            check: "compose",
            error: `docker compose up failed: ${last}`,
            fix: "Fix what the output above says, then run the setup again.",
          },
        ),
      );
    });
  });
}

const logsOf = (service: string) =>
  docker(["compose", "logs", "--no-color", "--no-log-prefix", "--tail", "80", service]).stdout;

const inTailscale = (args: string[], timeoutMs = 20_000) =>
  docker(["compose", "exec", "-T", "tailscale", "tailscale", ...args], timeoutMs);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Health, and whether an account exists yet, asked inside the app's container whatever port it's published on. */
const APP_PROBE = `const p = process.env.PORT || 3000;
const get = (path) => fetch("http://127.0.0.1:" + p + path).then((r) => r.json());
Promise.all([get("/api/health"), get("/api/app/auth-config")]).then(
  ([health, auth]) => console.log(JSON.stringify({ health, firstRun: auth.firstRun })),
  () => process.exit(1),
);`;

/** Waits for /api/health, and for `until`; `notYet` is the failure when the app answers but `until` never holds. */
async function waitForApp(timeoutS: number, until: (app: App) => boolean = () => true, notYet?: Problem): Promise<App> {
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    let healthy = false;
    const probe = docker(["compose", "exec", "-T", "agentes", "bun", "-e", APP_PROBE], 20_000);
    if (probe.code === 0) {
      try {
        const app = JSON.parse(probe.stdout) as App;
        healthy = app.health.status === "ok";
        if (healthy && until(app)) return app;
      } catch {
        // Not answering JSON yet.
      }
    } else {
      const problem = diagnoseAppLogs(logsOf("agentes"));
      if (problem) throw new SetupError(problem);
    }
    if (Date.now() > deadline) {
      throw new SetupError(
        healthy && notYet
          ? notYet
          : {
              check: "app.health",
              error: `The app didn't answer /api/health within ${timeoutS} seconds.`,
              fix: "docker compose logs agentes shows why. Run the setup again once it's fixed (--timeout waits longer).",
            },
      );
    }
    await sleep(2000);
  }
}

// ── The setup ───────────────────────────────────────────────────────────────

type Env = { read(): string | null; save(content: string): void };

async function run(opts: Options, ui: Ui, image: boolean): Promise<Result> {
  const dir = process.cwd();
  const envPath = join(dir, ".env");
  let content = existsSync(envPath) ? readFileSync(envPath, "utf8") : null;
  const env: Env = {
    read: () => content,
    save(next) {
      try {
        writeFileSync(envPath, next, { mode: 0o600 });
        chmodSync(envPath, 0o600);
      } catch (error) {
        throw new SetupError({
          check: "env",
          error: `Can't write .env in ${dir}: ${(error as Error).message}`,
          fix: "Run the setup as the user who owns this directory and its .env (ls -l shows who).",
        });
      }
      content = next;
    },
  };

  if (opts.tailscaleStatus) return finishFromStatus(opts, ui, env);

  ui.title("agentes.chat setup");
  const composeFile: string | null = COMPOSE_FILES.find((name) => existsSync(join(dir, name))) ?? null;
  const found = [content !== null ? ".env" : null, composeFile].filter(Boolean).join(" and ");
  ui.note(found ? `Found ${found} in ${dir}: only what's missing is filled in.` : `Setting up in ${dir}.`);

  // Docker first: without it nothing below can run.
  const dockerCheck = image ? null : checkDocker();
  if (dockerCheck && "problem" in dockerCheck && !opts.dryRun) throw new SetupError(dockerCheck.problem);
  if (dockerCheck && "label" in dockerCheck) ui.ok(dockerCheck.label);

  // A dry run asks nothing: it lists what the real run would ask.
  const ask = ui.canAsk;
  const listQuestions = opts.dryRun && !opts.json && opts.tailscaleStatus !== "-";
  const questions: string[] = [];
  const current = networkOf(content);
  if (listQuestions && !opts.network) {
    questions.push(`how people reach it (${current ?? "tailscale"} unless you choose otherwise)`);
  }
  const network: Network =
    opts.network ??
    (ask
      ? await ui.choose<Network>(
          "How will people reach this instance?",
          [
            {
              value: "tailscale",
              label: "Tailscale: private HTTPS on your tailnet, no domain or open port (recommended)",
            },
            { value: "domain", label: "A public domain, with HTTPS on ports 80 and 443" },
            { value: "local", label: "This machine only (http://localhost)" },
            // Last, so that piped answers 1 to 3 mean the same whatever the .env holds.
            ...(current === "proxy"
              ? [
                  {
                    value: "proxy" as const,
                    label: `Keep ${envValue(content, "PUBLIC_URL")}: your own proxy or tunnel`,
                  },
                ]
              : []),
          ],
          current ?? "tailscale",
        )
      : (current ?? "tailscale"));

  const entries: Record<string, string> = secretEntries(content);
  const newSecrets = Object.keys(entries);
  const hostname = opts.hostname ?? (envValue(content, "TS_HOSTNAME") || DEFAULT_HOSTNAME);
  const port = envValue(content, "HOST_PORT") || "3000";
  let tailscale: "given" | "env" | "joined" | "ask" | "missing" = "missing";
  let domain: string | null = null;

  if (network === "tailscale") {
    if (opts.hostname) entries.TS_HOSTNAME = opts.hostname;
    tailscale = opts.tailscaleKey
      ? "given"
      : envValue(content, "TS_AUTHKEY")
        ? "env"
        : isTailnetUrl(envValue(content, "PUBLIC_URL"))
          ? "joined"
          : ask || listQuestions
            ? "ask"
            : "missing";
    let key = opts.tailscaleKey ?? null;
    if (tailscale === "ask" && ask) {
      tailscaleSteps(ui, hostname, opts.tailscaleTag);
      key = await ui.ask("Paste the auth key", {
        secret: true,
        missing: PROBLEMS.keyMissing,
        validate: tailscaleKeyProblem,
      });
    }
    if (key) Object.assign(entries, tailscaleKeyEntries(key, opts.tailscaleTag, envValue(content, "TS_EXTRA_ARGS")));
    if (tailscale === "missing" && !opts.dryRun) throw new SetupError(PROBLEMS.keyMissing);
  } else if (network === "domain") {
    const missing = { check: "domain", error: "A public domain is needed.", fix: "Pass --domain chat.example.com." };
    domain = opts.domain ?? (envValue(content, "DOMAIN") || null);
    if (!domain && ask) {
      ui.list("A public domain", [
        "Point a DNS A record for it (and AAAA if this server has IPv6) at this server's public IP.",
        "Open ports 80 and 443 in the server's firewall: Caddy gets a Let's Encrypt certificate on them.",
      ]);
      const answer = await ui.ask("Domain", { missing, validate: (v) => domainProblem(normalizeDomain(v)) });
      domain = normalizeDomain(answer);
    }
    if (!domain && listQuestions) questions.push("the domain");
    if (!domain && !opts.dryRun) throw new SetupError(missing);
  }
  const way = wayIn(content, network, domain);
  Object.assign(entries, way.entries);
  const stop = stopCommand(content, way.profile);

  const preset = emailPreset(opts, content);
  if (listQuestions && preset === null) questions.push("email for invitations and password resets (skip by default)");
  const email = await emailEntries(opts, ui, preset, content, network, domain, entries);

  const plan = planSteps({
    docker:
      dockerCheck === null
        ? null
        : "label" in dockerCheck
          ? dockerCheck.label
          : `${dockerCheck.problem.error} ${dockerCheck.problem.fix}`,
    questions,
    envExists: content !== null,
    newSecrets,
    network,
    publicUrl: { now: envValue(content, "PUBLIC_URL"), next: way.entries.PUBLIC_URL ?? null },
    stop,
    hostname,
    tailscale,
    domain,
    email,
    compose: composeFile,
    start: opts.start,
    image,
  });
  if (opts.dryRun) {
    ui.list("The plan (--dry-run: nothing is written or started)", plan);
    return { ok: true, dryRun: true, network, plan };
  }

  env.save(upsertEnv(withNetworkProfile(content ?? ENV_HEADER, way.profile), entries));
  const written = Object.keys(entries).filter((key) => key !== "TS_EXTRA_ARGS");
  ui.ok(`.env${written.length ? `: ${written.join(", ")}` : " kept as it was"} (readable by you only)`);

  await ensureComposeFile(ui, dir, composeFile, network);

  if (image || !opts.start) return printCommands(ui, image, network, domain, content, stop);
  if (stop) {
    ui.note(`Removing the way in .env no longer uses (docker ${stop.join(" ")})…`);
    const removed = docker(stop, 120_000);
    if (removed.code !== 0) {
      throw new SetupError({
        check: "compose",
        error: `docker ${stop.join(" ")} failed: ${removed.stderr.trim().split("\n").pop() ?? ""}`,
        fix: `Fix that, run docker ${stop.join(" ")} yourself, then run the setup again.`,
      });
    }
  }
  if (network === "tailscale") return startTailscale(opts, ui, env);
  if (network === "domain") return startDomain(opts, ui, domain as string, env);
  ui.note("Starting agentes.chat (docker compose up -d). The first time downloads about 2 GB…");
  await composeUp(ui);
  const app = await waitForApp(opts.timeout);
  ui.ok(`agentes.chat ${app.health.version ?? ""} is up`);
  return finish(ui, network, envValue(env.read(), "PUBLIC_URL") ?? `http://localhost:${port}`, app, null);
}

function tailscaleSteps(ui: Ui, hostname: string, tag: string) {
  ui.title("Tailscale");
  ui.write(`This server joins your tailnet as "${hostname}", at https://${hostname}.<your tailnet>.ts.net with a real`);
  ui.write(`certificate. Only devices in your tailnet reach it. No tailnet yet? Sign up free: ${TS.signup}`);
  ui.list(
    "In the Tailscale admin console",
    [
      `DNS page, ${TS.dns}: if you see "Enable MagicDNS", click it. Under "HTTPS Certificates", click "Enable HTTPS" and confirm (device names go in a public certificate log).`,
      `Keys page, ${TS.keys}: click "Generate auth key". Leave Reusable and Ephemeral off, turn "Pre-approved" on if you see it, and click "Generate key". Copy the key (tskey-auth-…): it's shown once and works once.`,
    ],
    true,
  );
  ui.list("Unattended, or an AI agent installing? An OAuth client secret instead of step 2", [
    `Access controls, ${TS.policy}: under "tagOwners" add "${tag}": ["autogroup:admin"], and save.`,
    `Trust credentials, ${TS.trust}: click "Credential", choose OAuth, give "Auth Keys" Write access with the tag ${tag}, and click "Generate credential".`,
    `Paste its secret (tskey-client-…) below, or pass it as --tailscale-key. The server joins as ${tag}, approved, with a key that never expires.`,
  ]);
}

/** The email answer the options or the .env already give; null when it's a question. */
function emailPreset(opts: Options, content: string | null): EmailChoice | "set" | null {
  if (opts.email) return opts.email;
  if (opts.smtpUrl) return "smtp";
  if (opts.emailApiKey) return "api";
  return envValue(content, "SMTP_URL") || envValue(content, "MILLIONSEND_API_KEY") ? "set" : null;
}

async function emailEntries(
  opts: Options,
  ui: Ui,
  preset: EmailChoice | "set" | null,
  content: string | null,
  network: Network,
  domain: string | null,
  entries: Record<string, string>,
): Promise<EmailChoice | "set"> {
  const choice: EmailChoice | "set" =
    preset ??
    (ui.canAsk
      ? await ui.choose(
          "Email for invitations and password resets (optional)",
          [
            { value: "skip", label: "Skip for now: invitation links can be copied in the app" },
            { value: "smtp", label: "An SMTP server" },
            { value: "api", label: "A Resend-compatible API (MillionSend, Resend)" },
          ],
          "skip",
        )
      : "skip");
  if (choice === "skip" || choice === "set" || opts.dryRun) return choice;
  const value = (given: string | undefined, flag: string, question: string, o: AskOptions) => {
    const missing = { check: "email", error: `${question} is needed for ${choice} email.`, fix: `Pass ${flag}.` };
    if (given) return Promise.resolve(given);
    if (!ui.canAsk) throw new SetupError(missing);
    return ui.ask(question, { ...o, missing });
  };
  if (choice === "smtp") {
    entries.SMTP_URL = await value(opts.smtpUrl, "--smtp-url", "SMTP URL (smtps://user:password@host:465)", {
      secret: true,
      validate: smtpUrlProblem,
    });
  } else {
    entries.MILLIONSEND_API_KEY = await value(opts.emailApiKey, "--email-api-key", "API key", { secret: true });
    const url =
      opts.emailApiUrl ??
      (ui.canAsk ? await ui.ask("API address", { initial: DEFAULT_EMAIL_API_URL, validate: httpUrlProblem }) : null);
    if (url && url !== DEFAULT_EMAIL_API_URL) entries.MILLIONSEND_API_URL = url;
  }
  if (!envValue(content, "EMAIL_FROM")) {
    // Without one, mail goes out as ola@ the server's own host, which no provider verifies for a ts.net name or localhost.
    const fallback = network === "domain" && domain ? `agentes <ola@${domain}>` : undefined;
    entries.EMAIL_FROM = await value(opts.emailFrom ?? (ui.canAsk ? undefined : fallback), "--email-from", "Sender", {
      validate: emailFromProblem,
      ...(fallback ? { initial: fallback } : {}),
    });
  }
  return choice;
}

async function ensureComposeFile(ui: Ui, dir: string, file: string | null, network: Network) {
  const service = network === "tailscale" ? "tailscale" : network === "domain" ? "caddy" : null;
  const content = file ? readFileSync(join(dir, file), "utf8") : null;
  if (file && (!service || new RegExp(`^ {2}${service}:`, "m").test(content ?? ""))) return;
  if (file) {
    const outdated = {
      check: "compose",
      error: `${file} has no ${service} service: it's from an older release.`,
      fix: `Download the current one (your settings live in .env): curl -fsSLO ${COMPOSE_URL}, then run the setup again.`,
    };
    if (!ui.interactive) throw new SetupError(outdated);
    const answer = await ui.ask(`${outdated.error} Download the current one over it? Settings stay in .env (y/n)`, {
      initial: "y",
    });
    if (!answer.toLowerCase().startsWith("y")) throw new SetupError(outdated);
  }
  try {
    const response = await fetch(COMPOSE_URL, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    // Over the outdated file itself: Compose keeps reading a compose.yaml next to a newer docker-compose.yml.
    writeFileSync(join(dir, file ?? "docker-compose.yml"), await response.text());
  } catch (error) {
    throw new SetupError({
      check: "compose.download",
      error: `Couldn't download docker-compose.yml: ${(error as Error).message}`,
      fix: `Download it into this directory yourself, curl -fsSLO ${COMPOSE_URL}, then run the setup again.`,
    });
  }
  ui.ok(`${file ?? "docker-compose.yml"} downloaded`);
}

/** Inside the image, or with --no-start: the commands that finish the job. */
function printCommands(
  ui: Ui,
  image: boolean,
  network: Network,
  domain: string | null,
  content: string | null,
  stop: string[] | null,
): Result {
  const port = envValue(content, "HOST_PORT") || "3000";
  const setup = `docker run --rm -i --user "$(id -u):$(id -g)" -v "$PWD":/work -w /work ${envValue(content, "AGENTES_IMAGE") || IMAGE} setup`;
  const start =
    image && network === "tailscale"
      ? [
          "docker compose up -d tailscale",
          `Once Tailscale is on your tailnet (about a minute), write its address into .env: docker compose exec -T tailscale tailscale status --json | ${setup} --tailscale-status -`,
          "docker compose up -d (starts the app with that address)",
        ]
      : image && network === "domain"
        ? [
            "docker compose up -d",
            `Create your account first, through an SSH tunnel from your computer (ssh -L ${port}:localhost:${port} you@this-server, then open http://localhost:${port}): the first account owns the instance.`,
            `Then in .env set PUBLIC_URL=https://${domain} and add https to COMPOSE_PROFILES, and run docker compose up -d.`,
          ]
        : [
            "docker compose up -d",
            ...(image ? [] : ["Run the setup again: it waits for the instance and prints its address."]),
          ];
  const commands = [...(stop ? [`docker ${stop.join(" ")} (the way in .env no longer uses)`] : []), ...start];
  ui.list("Next, in this directory", commands, true);
  return { ok: true, network, started: false, nextSteps: commands };
}

async function startTailscale(opts: Options, ui: Ui, env: Env): Promise<Result> {
  ui.note("Starting Tailscale (docker compose up -d tailscale)…");
  await composeUp(ui, ["tailscale"]);
  const joined = await joinTailnet(opts, ui, env);
  ui.ok(`On your tailnet as ${new URL(joined.url).host}`);
  savePublicUrl(ui, env, joined.url);

  ui.note("Starting agentes.chat (docker compose up -d). The first time downloads about 2 GB…");
  await composeUp(ui);
  const tailnet = await joinTailnet(opts, ui, env);
  // A new TS_HOSTNAME is set only once the node is back on the tailnet under its old name.
  if (tailnet.url !== joined.url) {
    ui.ok(`Renamed on your tailnet: ${new URL(tailnet.url).host}`);
    savePublicUrl(ui, env, tailnet.url);
    await composeUp(ui);
  }
  const host = new URL(tailnet.url).host;
  await ensureServe(opts, ui, env, host);
  await waitForCertificate(opts, ui, host);
  ui.ok("HTTPS certificate ready");
  const app = await waitForApp(opts.timeout);
  ui.ok(`agentes.chat ${app.health.version ?? ""} is up`);
  return finish(ui, "tailscale", tailnet.url, app, tailnet.keyExpiry);
}

/** PUBLIC_URL is the address Tailscale gives; the key goes, since the state volume keeps the node logged in. */
function savePublicUrl(ui: Ui, env: Env, url: string) {
  const current = env.read() ?? "";
  env.save(upsertEnv(current, { PUBLIC_URL: url, ...(envValue(current, "TS_AUTHKEY") ? { TS_AUTHKEY: "" } : {}) }));
  ui.ok(`.env: PUBLIC_URL=${url}`);
}

/** Waits for the tailnet; on a terminal, a refused or missing key is asked for again. */
async function joinTailnet(opts: Options, ui: Ui, env: Env): Promise<{ url: string; keyExpiry: string | null }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await waitForTailnet(opts, ui, Boolean(envValue(env.read(), "TS_AUTHKEY")));
    } catch (error) {
      if (!(error instanceof SetupError) || error.problem.check !== "tailscale.key" || !ui.interactive || attempt > 3) {
        throw error;
      }
      ui.fail(error.problem);
      const key = await ui.ask("Paste a new auth key", { missing: PROBLEMS.keyMissing, validate: tailscaleKeyProblem });
      const current = env.read() ?? "";
      env.save(upsertEnv(current, tailscaleKeyEntries(key, opts.tailscaleTag, envValue(current, "TS_EXTRA_ARGS"))));
      await composeUp(ui, ["tailscale"]);
    }
  }
}

async function waitForTailnet(
  opts: Options,
  ui: Ui,
  hasKey: boolean,
): Promise<{ url: string; keyExpiry: string | null }> {
  const deadline = Date.now() + opts.timeout * 1000;
  let said = "";
  for (;;) {
    const status = inTailscale(["status", "--json"]);
    const state = status.code === 0 ? readTailscaleStatus(status.stdout) : null;
    if (state?.kind === "ready") return state;
    // A tailnet setting someone can switch on while this waits; without a terminal, say it at once.
    const setting = state?.kind === "problem" ? state.problem : null;
    if (setting && !ui.interactive) throw new SetupError(setting);
    const logged = setting ? null : diagnoseTailscaleLogs(logsOf("tailscale"), opts.tailscaleTag);
    if (logged && logged !== "approval") throw new SetupError(logged);
    if (state?.kind === "waiting" && state.reason === "login" && !hasKey) throw new SetupError(PROBLEMS.keyMissing);
    const approval = (state?.kind === "waiting" && state.reason === "approval") || logged === "approval";
    const message = setting
      ? `${setting.error} ${setting.fix} The setup goes on once it's on…`
      : approval
        ? `Waiting for approval: open ${TS.machines}, find the server marked "Needs approval", and choose Approve in its … menu.`
        : "Waiting for Tailscale to join your tailnet…";
    if (message !== said) {
      ui.note(message);
      said = message;
    }
    if (Date.now() > deadline) {
      throw new SetupError(
        setting ??
          (approval
            ? PROBLEMS.approval
            : {
                check: "tailscale.timeout",
                error: `Tailscale didn't join your tailnet within ${opts.timeout} seconds.`,
                fix: "docker compose logs tailscale shows why. Run the setup again once it's fixed (--timeout waits longer).",
              }),
      );
    }
    await sleep(2000);
  }
}

/**
 * The HTTPS proxy comes from the compose file's serve config, applied once the node knows its name. A node
 * that joined while HTTPS was still off in the tailnet may hold an empty one: a restart applies it again.
 */
async function ensureServe(opts: Options, ui: Ui, env: Env, host: string) {
  const served = () => inTailscale(["serve", "status", "--json"]).stdout.includes(`"${host}:443"`);
  if (served()) return;
  ui.note("Applying the HTTPS proxy (docker compose restart tailscale)…");
  docker(["compose", "restart", "tailscale"], 60_000);
  await joinTailnet(opts, ui, env);
  for (let i = 0; i < 10 && !served(); i++) await sleep(2000);
  if (!served()) {
    throw new SetupError({
      check: "tailscale.serve",
      error: "Tailscale didn't turn on the HTTPS proxy for this server.",
      fix: 'docker compose logs tailscale shows why (the lines with "serve proxy"). Run the setup again once it\'s fixed.',
    });
  }
}

/** Asks Tailscale for the certificate the HTTPS proxy serves, so the first visit doesn't wait for it. */
async function waitForCertificate(opts: Options, ui: Ui, host: string) {
  ui.note(`Getting the HTTPS certificate for ${host}…`);
  const deadline = Date.now() + opts.timeout * 1000;
  for (;;) {
    // The certificate alone, to stdout: the private key is never written anywhere.
    const cert = inTailscale(["cert", "--cert-file", "-", host], Math.max(5_000, deadline - Date.now()));
    if (cert.code === 0 && cert.stdout.includes("BEGIN CERTIFICATE")) return;
    if (Date.now() > deadline) {
      throw new SetupError({
        check: "tailscale.cert",
        error: `Tailscale couldn't get an HTTPS certificate for ${host}: ${cert.stderr.trim().split("\n").pop() ?? ""}`,
        fix: `Check that HTTPS is on (${TS.dns}, "HTTPS Certificates"), then run the setup again. Let's Encrypt limits how often one name gets a certificate, so after many tries wait a few hours.`,
      });
    }
    await sleep(3000);
  }
}

async function startDomain(opts: Options, ui: Ui, domain: string, env: Env): Promise<Result> {
  const url = `https://${domain}`;
  if (envValue(env.read(), "PUBLIC_URL") !== url) {
    ui.note("Starting agentes.chat on this machine only (docker compose up -d). The first time downloads about 2 GB…");
    await composeUp(ui);
    const app = await waitForApp(opts.timeout);
    if (app.firstRun) {
      const port = envValue(env.read(), "HOST_PORT") || "3000";
      const steps = [
        `From your computer, open a tunnel to this server: ssh -L ${port}:localhost:${port} you@this-server`,
        `Open http://localhost:${port} and create your account: the first one owns the instance.`,
      ];
      if (!ui.interactive) {
        const next = [...steps, `Run the setup again: it turns on HTTPS for ${domain}.`];
        ui.list("Next", next, true);
        return { ok: true, network: "domain", stage: "owner", url: `http://localhost:${port}`, nextSteps: next };
      }
      ui.list(`Create your account before ${domain} goes live`, steps, true);
      // A person has to open the tunnel and sign up: longer than any service gets to start.
      const minutes = Math.max(30, Math.ceil(opts.timeout / 60));
      ui.note(`Waiting for the account (up to ${minutes} minutes)…`);
      await waitForApp(minutes * 60, (a) => !a.firstRun, {
        check: "domain.owner",
        error: `No account was created within ${minutes} minutes.`,
        fix: `Create it through the tunnel (the steps above), then run the setup again: it turns on HTTPS for ${domain}.`,
      });
      ui.ok("Account created");
    }
    env.save(upsertEnv(withNetworkProfile(env.read() ?? "", "https"), { PUBLIC_URL: url }));
    ui.ok(`.env: PUBLIC_URL=${url}, https in COMPOSE_PROFILES`);
  }
  await composeUp(ui);
  const app = await waitForApp(opts.timeout);
  ui.note(`Waiting for ${url} (Caddy gets its certificate)…`);
  const deadline = Date.now() + opts.timeout * 1000;
  for (;;) {
    let failure: unknown = null;
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) break;
      failure = `HTTP ${response.status}`;
    } catch (error) {
      failure = (error as { cause?: unknown }).cause ?? error;
    }
    if (Date.now() > deadline) {
      throw new SetupError(
        /ENOTFOUND|EAI_AGAIN/.test(String(failure))
          ? {
              check: "domain.dns",
              error: `${domain} doesn't resolve to an address yet.`,
              fix: "Add a DNS A record for it pointing at this server's public IP (AAAA for IPv6), wait a few minutes, then run the setup again.",
            }
          : {
              check: "domain.https",
              error: `${url} doesn't answer yet (${String(failure)}).`,
              fix: "Ports 80 and 443 must be open to the internet and the DNS record must point here; docker compose logs caddy says why a certificate failed. Then run the setup again.",
            },
      );
    }
    await sleep(3000);
  }
  ui.ok(`${url} answers with a valid certificate`);
  return finish(ui, "domain", url, app, null);
}

/** Inside the image: `tailscale status --json` on stdin (or in a file) gives the address for .env. */
function finishFromStatus(opts: Options, ui: Ui, env: Env): Result {
  const raw = readFileSync(opts.tailscaleStatus === "-" ? "/dev/stdin" : (opts.tailscaleStatus as string), "utf8");
  const state = readTailscaleStatus(raw);
  if (state.kind === "problem") throw new SetupError(state.problem);
  if (state.kind === "waiting") {
    throw new SetupError(
      state.reason === "approval"
        ? PROBLEMS.approval
        : {
            check: "tailscale.join",
            error: "Tailscale isn't on your tailnet yet.",
            fix: "Wait a minute and run the same command again; docker compose logs tailscale shows what it's doing.",
          },
    );
  }
  if (env.read() === null) {
    throw new SetupError({
      check: "env",
      error: "There's no .env here.",
      fix: 'Run it in the directory with your .env and docker-compose.yml (that\'s what -v "$PWD":/work does).',
    });
  }
  if (opts.dryRun) {
    const plan = [`.env: PUBLIC_URL=${state.url}${envValue(env.read(), "TS_AUTHKEY") ? ", TS_AUTHKEY emptied" : ""}`];
    ui.list("The plan (--dry-run: nothing is written or started)", plan);
    return { ok: true, dryRun: true, network: "tailscale", plan };
  }
  savePublicUrl(ui, env, state.url);
  return finish(ui, "tailscale", state.url, null, state.keyExpiry, [
    "Run docker compose up -d: it starts the app with this address.",
  ]);
}

function finish(
  ui: Ui,
  network: Network,
  url: string,
  app: App | null,
  keyExpiry: string | null,
  first: string[] = [],
): Result {
  const link = network === "local" ? null : phoneLink(url);
  ui.write("");
  ui.write(`  ${url}`);
  if (link) {
    ui.write("");
    ui.qr(link);
    ui.note(`  ${link}`);
  }
  const steps = [...first, ...nextSteps({ network, url, firstRun: app?.firstRun ?? null, keyExpiry })];
  ui.list("Next", steps, true);
  return {
    ok: true,
    network,
    url,
    health: app?.health ?? null,
    ownerExists: app ? !app.firstRun : null,
    phoneLink: link,
    nextSteps: steps,
  };
}
