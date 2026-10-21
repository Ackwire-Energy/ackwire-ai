import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMPOSE_FILES,
  DEFAULT_TAG,
  DEFAULT_TIMEOUT_S,
  diagnoseAppLogs,
  diagnoseCompose,
  diagnoseTailscaleLogs,
  domainProblem,
  envName,
  envValue,
  isTailnetUrl,
  networkOf,
  nextSteps,
  normalizeDomain,
  type PlanInput,
  PROBLEMS,
  parseOptions,
  phoneLink,
  planSteps,
  qrCode,
  quoteEnvValue,
  readTailscaleStatus,
  resolveChoice,
  secretEntries,
  tailscaleKeyEntries,
  tailscaleKeyProblem,
  upsertEnv,
  versionAtLeast,
  withNetworkProfile,
} from "../src/lib";

const root = join(import.meta.dir, "../../..");
const AUTH_KEY = "tskey-auth-kAbC123CNTRL-SECRETabc123";
const CLIENT_SECRET = "tskey-client-kXyZ789CNTRL-SECRETxyz789";

describe("options", () => {
  const parse = (argv: string[], env: Record<string, string> = {}) => parseOptions(argv, env);

  test("defaults: ask for what's missing, start, wait 5 minutes", () => {
    expect(parse([])).toEqual({
      options: {
        tailscaleTag: DEFAULT_TAG,
        start: true,
        timeout: DEFAULT_TIMEOUT_S,
        dryRun: false,
        json: false,
        help: false,
      },
    });
  });

  test("every answer as a flag, or as AGENTES_SETUP_<OPTION>", () => {
    const flags = parse([
      "--network",
      "tailscale",
      "--tailscale-key",
      AUTH_KEY,
      "--hostname",
      "chat",
      "--email",
      "smtp",
      "--smtp-url",
      "smtps://u:p@smtp.example.com:465",
      "--email-from",
      "agentes <ola@example.com>",
      "--no-start",
      "--timeout",
      "60",
      "--json",
      "--dry-run",
    ]);
    expect(flags).toMatchObject({
      options: {
        network: "tailscale",
        tailscaleKey: AUTH_KEY,
        hostname: "chat",
        email: "smtp",
        smtpUrl: "smtps://u:p@smtp.example.com:465",
        emailFrom: "agentes <ola@example.com>",
        start: false,
        timeout: 60,
        json: true,
        dryRun: true,
      },
    });
    expect(envName("tailscale-key")).toBe("AGENTES_SETUP_TAILSCALE_KEY");
    const fromEnv = parse([], {
      AGENTES_SETUP_NETWORK: "domain",
      AGENTES_SETUP_DOMAIN: "https://Chat.Example.com/",
      AGENTES_SETUP_NO_START: "1",
      AGENTES_SETUP_JSON: "true",
    });
    expect(fromEnv).toMatchObject({
      options: { network: "domain", domain: "chat.example.com", start: false, json: true },
    });
    // A flag wins over the environment.
    expect(parse(["--network", "local"], { AGENTES_SETUP_NETWORK: "domain" })).toMatchObject({
      options: { network: "local" },
    });
  });

  test("a wrong value is refused before anything runs, with the option's name", () => {
    expect(parse(["--network", "vpn"])).toEqual({ error: "--network is tailscale, domain or local." });
    expect(parse(["--email", "yes"])).toEqual({ error: "--email is skip, smtp or api." });
    expect(parse(["--timeout", "soon"])).toEqual({ error: "--timeout is a number of seconds." });
    expect(parse(["--tailscale-key", "abc"])).toMatchObject({ error: expect.stringMatching(/^--tailscale-key: /) });
    expect(parse(["--hostname", "My Server"])).toMatchObject({ error: expect.stringMatching(/^--hostname: /) });
    expect(parse(["--tailscale-tag", "agentes"])).toMatchObject({ error: expect.stringMatching(/^--tailscale-tag: /) });
    expect(parse(["--smtp-url", "smtp.example.com"])).toMatchObject({ error: expect.stringMatching(/^--smtp-url: /) });
    expect(parse(["--email-from", "ola"])).toMatchObject({ error: expect.stringMatching(/^--email-from: /) });
    expect(parse(["--frobnicate"])).toMatchObject({ error: expect.stringContaining("--help") });
  });

  test("a numbered answer, or the name itself", () => {
    const values = ["tailscale", "domain", "local"] as const;
    expect(resolveChoice("2", values)).toBe("domain");
    expect(resolveChoice(" Local ", values)).toBe("local");
    expect(resolveChoice("4", values)).toBeNull();
    expect(resolveChoice("vpn", values)).toBeNull();
  });
});

describe("answers", () => {
  test("Tailscale keys: auth keys and OAuth client secrets, never an API token", () => {
    expect(tailscaleKeyProblem(AUTH_KEY)).toBeNull();
    expect(tailscaleKeyProblem(CLIENT_SECRET)).toBeNull();
    expect(tailscaleKeyProblem(`${CLIENT_SECRET}?ephemeral=false&preauthorized=true`)).toBeNull();
    expect(tailscaleKeyProblem("tskey-api-kAbC123CNTRL-SECRET")).toContain("API access token");
    expect(tailscaleKeyProblem("tskey-auth-short")).toContain("isn't a Tailscale auth key");
    expect(tailscaleKeyProblem(`${AUTH_KEY} trailing`)).toContain("isn't a Tailscale auth key");
  });

  test("domains: pasted addresses become names; ts.net names belong to Tailscale", () => {
    expect(normalizeDomain(" https://Chat.Example.com/login?x=1 ")).toBe("chat.example.com");
    expect(domainProblem("chat.example.com")).toBeNull();
    expect(domainProblem("localhost")).not.toBeNull();
    expect(domainProblem("10.0.0.1")).not.toBeNull();
    expect(domainProblem("box.tail1234.ts.net")).toContain("Tailscale");
  });
});

describe(".env", () => {
  test("values are read the way Compose reads them", () => {
    const env = '# comment\nexport A=1\nB = \'two words\'\nC="say \\"hi\\""\nD=plain # note\nE=\n';
    expect(envValue(env, "A")).toBe("1");
    expect(envValue(env, "B")).toBe("two words");
    expect(envValue(env, "C")).toBe('say "hi"');
    expect(envValue(env, "D")).toBe("plain");
    expect(envValue(env, "E")).toBe("");
    expect(envValue(env, "F")).toBeNull();
    expect(envValue(null, "A")).toBeNull();
  });

  test("lines change in place, duplicates go, new keys at the end, comments stay", () => {
    const env = "# mine\nPUBLIC_URL=http://localhost:3000\nX=1\nPUBLIC_URL=http://old\n";
    expect(upsertEnv(env, { PUBLIC_URL: "https://box.tail1234.ts.net", NEW: "v" })).toBe(
      "# mine\nPUBLIC_URL=https://box.tail1234.ts.net\nX=1\nNEW=v\n",
    );
    expect(upsertEnv("", { A: "1" })).toBe("A=1\n");
    expect(upsertEnv("A=1\n", {})).toBe("A=1\n");
  });

  test("anything a value holds comes back unchanged", () => {
    for (const value of [
      "plain-value_1.2/3:4@5%6+7=8,9",
      "has space",
      "pa$$word#1",
      "it's",
      `${CLIENT_SECRET}?ephemeral=false&preauthorized=true`,
      "",
    ]) {
      expect(envValue(upsertEnv("", { K: value }), "K")).toBe(value);
    }
    expect(quoteEnvValue("line\nbreak")).toBe("linebreak");
  });

  test("one way in: tailscale or https in COMPOSE_PROFILES, other profiles kept", () => {
    expect(envValue(withNetworkProfile("", "tailscale"), "COMPOSE_PROFILES")).toBe("tailscale");
    const both = "COMPOSE_PROFILES=https,backup\n";
    expect(envValue(withNetworkProfile(both, "tailscale"), "COMPOSE_PROFILES")).toBe("backup,tailscale");
    expect(envValue(withNetworkProfile(both, null), "COMPOSE_PROFILES")).toBe("backup");
    expect(withNetworkProfile("A=1\n", null)).toBe("A=1\n");
    expect(withNetworkProfile("COMPOSE_PROFILES=tailscale\n", "tailscale")).toBe("COMPOSE_PROFILES=tailscale\n");
  });

  test("the network a .env already says", () => {
    expect(networkOf(null)).toBeNull();
    expect(networkOf("AGENTES_SECRET=x\n")).toBeNull();
    expect(networkOf("PUBLIC_URL=http://localhost:3000\n")).toBe("local");
    expect(networkOf("COMPOSE_PROFILES=backup,tailscale\n")).toBe("tailscale");
    expect(networkOf("COMPOSE_PROFILES=https\n")).toBe("domain");
    expect(networkOf("DOMAIN=chat.example.com\nPUBLIC_URL=http://localhost:3000\n")).toBe("domain");
  });

  test("secrets are generated only when missing, never replaced", () => {
    const fresh = secretEntries(null);
    expect(fresh.AGENTES_SECRET?.length).toBe(64);
    expect(fresh.POSTGRES_PASSWORD).toMatch(/^[0-9a-f]{48}$/);
    expect(secretEntries("AGENTES_SECRET=kept\nPOSTGRES_PASSWORD=kept\n")).toEqual({});
    expect(Object.keys(secretEntries("AGENTES_SECRET=kept\nPOSTGRES_PASSWORD=\n"))).toEqual(["POSTGRES_PASSWORD"]);
  });

  test("covers what the app requires: .env.example's required values come from the setup or the compose file", () => {
    const required = [...readFileSync(join(root, ".env.example"), "utf8").matchAll(/^# Required\.\n(\w+)=/gm)].map(
      (m) => m[1],
    );
    expect(required.sort()).toEqual(["AGENTES_SECRET", "DATABASE_URL"]);
    expect(Object.keys(secretEntries(null))).toContain("AGENTES_SECRET");
    expect(readFileSync(join(root, "docker-compose.yml"), "utf8")).toContain("DATABASE_URL:");
  });

  test("an OAuth client secret registers a tagged device that stays", () => {
    expect(tailscaleKeyEntries(AUTH_KEY, DEFAULT_TAG, null)).toEqual({ TS_AUTHKEY: AUTH_KEY });
    expect(tailscaleKeyEntries(CLIENT_SECRET, "tag:chat", "--ssh --advertise-tags=tag:old")).toEqual({
      TS_AUTHKEY: `${CLIENT_SECRET}?ephemeral=false&preauthorized=true`,
      TS_EXTRA_ARGS: "--ssh --advertise-tags=tag:chat",
    });
    const pasted = `${CLIENT_SECRET}?ephemeral=false`;
    expect(tailscaleKeyEntries(pasted, DEFAULT_TAG, null).TS_AUTHKEY).toBe(pasted);
  });
});

describe("Tailscale", () => {
  const status = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      BackendState: "Running",
      CurrentTailnet: { Name: "you@example.com", MagicDNSSuffix: "tail1234.ts.net", MagicDNSEnabled: true },
      CertDomains: ["agentes.tail1234.ts.net"],
      Self: { DNSName: "agentes.tail1234.ts.net.", KeyExpiry: "2027-04-19T12:00:00Z" },
      ...overrides,
    });

  test("on the tailnet with HTTPS: the address, and when its key expires", () => {
    expect(readTailscaleStatus(status())).toEqual({
      kind: "ready",
      url: "https://agentes.tail1234.ts.net",
      keyExpiry: "2027-04-19T12:00:00Z",
    });
    // A tagged device's key doesn't expire.
    expect(readTailscaleStatus(status({ Self: { DNSName: "agentes.tail1234.ts.net." } }))).toMatchObject({
      keyExpiry: null,
    });
  });

  test("the tailnet settings it needs, each with the click that fixes it", () => {
    expect(readTailscaleStatus(status({ CertDomains: null }))).toEqual({ kind: "problem", problem: PROBLEMS.https });
    expect(readTailscaleStatus(status({ CurrentTailnet: { MagicDNSEnabled: false }, CertDomains: [] }))).toEqual({
      kind: "problem",
      problem: PROBLEMS.magicDns,
    });
    expect(PROBLEMS.https.fix).toContain("Enable HTTPS");
    expect(PROBLEMS.magicDns.fix).toContain("Enable MagicDNS");
  });

  test("still on its way: starting, logging in, or waiting for approval", () => {
    expect(readTailscaleStatus(status({ BackendState: "NeedsMachineAuth" }))).toEqual({
      kind: "waiting",
      reason: "approval",
    });
    expect(readTailscaleStatus(status({ BackendState: "NeedsLogin" }))).toEqual({ kind: "waiting", reason: "login" });
    expect(readTailscaleStatus(status({ BackendState: "Starting" }))).toEqual({ kind: "waiting", reason: "starting" });
    expect(readTailscaleStatus("not json")).toEqual({ kind: "waiting", reason: "starting" });
  });

  test("the container's log says what went wrong; the latest line wins", () => {
    const refused = "boot: 2026/10/21 tailscale up failed: backend error: invalid key: API key kAbC123CNTRL not valid";
    expect(diagnoseTailscaleLogs(refused, DEFAULT_TAG)).toEqual(PROBLEMS.key);
    expect(diagnoseTailscaleLogs("requested tags [tag:agentes] are invalid or not permitted", "tag:x")).toMatchObject({
      check: "tailscale.tag",
      error: expect.stringContaining("tag:x"),
    });
    expect(
      diagnoseTailscaleLogs("boot: machine authorization required, please visit the admin panel", DEFAULT_TAG),
    ).toBe("approval");
    expect(
      diagnoseTailscaleLogs(
        "serve proxy: … To make it work, ensure that HTTPS is enabled for your tailnet",
        DEFAULT_TAG,
      ),
    ).toEqual(PROBLEMS.https);
    expect(diagnoseTailscaleLogs(`${refused}\nmachine authorization required`, DEFAULT_TAG)).toBe("approval");
    expect(diagnoseTailscaleLogs('boot: tailscaled in state "Starting", waiting', DEFAULT_TAG)).toBeNull();
  });

  test("addresses Tailscale gives", () => {
    expect(isTailnetUrl("https://agentes.tail1234.ts.net")).toBe(true);
    expect(isTailnetUrl("http://agentes.tail1234.ts.net")).toBe(false);
    expect(isTailnetUrl("https://chat.example.com")).toBe(false);
    expect(isTailnetUrl(null)).toBe(false);
  });
});

describe("Docker", () => {
  test("Compose versions, as each build prints them", () => {
    expect(versionAtLeast("2.23.1", "2.23.1")).toBe(true);
    expect(versionAtLeast("v2.29.7-desktop.1", "2.23.1")).toBe(true);
    expect(versionAtLeast("2.21.0", "2.23.1")).toBe(false);
    expect(versionAtLeast("1.29.2", "2.23.1")).toBe(false);
    expect(versionAtLeast("unknown", "2.23.1")).toBe(false);
  });

  test("a port in use names the port and the fix", () => {
    const app = diagnoseCompose(
      "Error response from daemon: driver failed programming external connectivity on endpoint x-agentes-1 (abc): Bind for 127.0.0.1:3000 failed: port is already allocated",
      "linux",
    );
    expect(app).toMatchObject({ check: "port", error: expect.stringContaining("Port 3000") });
    expect(app?.fix).toContain("HOST_PORT=3001");
    expect(app?.fix).toContain("ss -ltnp 'sport = :3000'");
    const web = diagnoseCompose(
      "Error response from daemon: Ports are not available: exposing port TCP 0.0.0.0:443 -> 0.0.0.0:0: listen tcp 0.0.0.0:443: bind: address already in use",
      "darwin",
    );
    expect(web).toMatchObject({ check: "port", error: expect.stringContaining("ports 80 and 443") });
    expect(web?.fix).toContain("lsof -nP -iTCP:443");
  });

  test("Docker itself: not running, not allowed, out of disk; anything else is shown as is", () => {
    expect(
      diagnoseCompose("Cannot connect to the Docker daemon at unix:///var/run/docker.sock.", "linux"),
    ).toMatchObject({
      check: "docker.daemon",
    });
    expect(
      diagnoseCompose(
        "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
        "linux",
      ),
    ).toMatchObject({ check: "docker.permission" });
    expect(diagnoseCompose("write /var/lib/docker/tmp/x: no space left on device", "linux")).toMatchObject({
      check: "disk",
    });
    expect(diagnoseCompose("something new went wrong", "linux")).toBeNull();
  });

  test("the app's own refusal names the values to fix", () => {
    const logs =
      "Invalid configuration:\n  - AGENTES_SECRET is required\n  - PUBLIC_URL: Invalid URL\n\nCopy .env.example";
    expect(diagnoseAppLogs(logs)).toMatchObject({
      check: "app.config",
      error: "The app refused its configuration: AGENTES_SECRET is required; PUBLIC_URL: Invalid URL.",
    });
    expect(diagnoseAppLogs('{"level":"info","msg":"starting agentes.chat"}')).toBeNull();
  });
});

describe("the end", () => {
  test("the phone link the apps open, and its QR code", () => {
    const link = phoneLink("https://agentes.tail1234.ts.net");
    expect(link).toBe("agenteschat://connect?server=https%3A%2F%2Fagentes.tail1234.ts.net");
    const rows = qrCode(link).split("\n");
    // Two modules per text row, square, with a quiet border.
    expect(rows.length).toBeGreaterThan(10);
    for (const row of rows) expect([...row].length).toBe([...(rows[0] as string)].length);
    expect(Math.abs([...(rows[0] as string)].length - rows.length * 2)).toBeLessThanOrEqual(1);
  });

  test("next steps: the tailnet, the phone, and the key that would expire", () => {
    const steps = nextSteps({
      network: "tailscale",
      url: "https://agentes.tail1234.ts.net",
      firstRun: true,
      keyExpiry: "2027-04-19T12:00:00Z",
    });
    expect(steps[0]).toBe(
      "On a computer or phone signed in to your tailnet, open https://agentes.tail1234.ts.net and create your account: the first one owns this instance.",
    );
    expect(steps.join("\n")).toContain('"Disable Key Expiry", or it leaves your tailnet on 2027-04-19');
    const local = nextSteps({ network: "local", url: "http://localhost:3001", firstRun: false, keyExpiry: null });
    expect(local).toEqual([
      "Open http://localhost:3001 and sign in.",
      "On a server, open it from your computer through an SSH tunnel: ssh -L 3001:localhost:3001 you@your-server",
    ]);
  });
});

describe("the plan", () => {
  const base: PlanInput = {
    docker: "Docker 27.3.1 with Compose 2.29.7",
    questions: [],
    envExists: false,
    newSecrets: ["AGENTES_SECRET", "POSTGRES_PASSWORD"],
    network: "tailscale",
    hostname: "agentes",
    tailscale: "ask",
    domain: null,
    email: "skip",
    compose: null,
    start: true,
    image: false,
  };

  test("an empty directory on a tailnet: every step, in order", () => {
    expect(planSteps(base)).toEqual([
      "Docker 27.3.1 with Compose 2.29.7",
      ".env: create it, readable by you only, with AGENTES_SECRET and POSTGRES_PASSWORD generated",
      "network: Tailscale, COMPOSE_PROFILES=tailscale, device name agentes",
      "Tailscale: show the admin console steps and ask for an auth key",
      "email: none for now (set SMTP_URL or MILLIONSEND_API_KEY later)",
      "compose: download docker-compose.yml from https://raw.githubusercontent.com/agentes-chat/agentes-chat/main/docker-compose.yml",
      "start: docker compose up -d tailscale, wait until it's on the tailnet with HTTPS",
      "PUBLIC_URL: write the address Tailscale gives it (https://<device>.<tailnet>.ts.net)",
      "start: docker compose up -d, wait for the HTTPS certificate and /api/health",
      "finish: the address, a QR code for the phone app, and what to do next",
    ]);
  });

  test("a second run keeps what's there", () => {
    const again = planSteps({
      ...base,
      envExists: true,
      newSecrets: [],
      tailscale: "joined",
      email: "set",
      compose: "docker-compose.yml",
    });
    expect(again).toContain(".env: keep it and add only what's missing");
    expect(again).toContain("Tailscale: already on the tailnet, no key needed");
    expect(again).toContain("email: keep what .env has");
    expect(again).toContain("compose: use docker-compose.yml");
  });

  test("a dry run lists the questions the real run asks", () => {
    const steps = planSteps({ ...base, questions: ["how people reach it", "email"] });
    expect(steps[1]).toBe("asks: how people reach it; email");
  });

  test("a public domain waits for the owner before going live", () => {
    const steps = planSteps({ ...base, network: "domain", domain: "chat.example.com" });
    expect(steps).toContain("network: public domain chat.example.com, HTTPS by Caddy on ports 80 and 443");
    expect(steps.some((s) => s.startsWith("owner: wait for the first account"))).toBe(true);
  });

  test("inside the image, and without starting: the commands to run", () => {
    const image = planSteps({ ...base, docker: null, image: true });
    expect(image[0]).toBe("Docker: not checked here (setup inside the image)");
    expect(image.at(-1)).toBe("start: print the commands to run (docker compose up -d) and how to finish");
    expect(planSteps({ ...base, start: false }).at(-1)).toBe(image.at(-1));
  });
});

describe("the compose file the setup drives", () => {
  const file = readFileSync(join(root, "docker-compose.yml"), "utf8");
  const compose = Bun.YAML.parse(file) as {
    services: Record<string, Record<string, unknown>>;
    configs: Record<string, { content: string }>;
    volumes: Record<string, unknown>;
  };

  test("is the one the setup downloads, looked for in Compose's own order", () => {
    expect(COMPOSE_FILES).toEqual(["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"]);
    expect(Object.keys(compose.services)).toEqual(
      expect.arrayContaining(["postgres", "agentes", "tailscale", "caddy"]),
    );
    expect(compose.services.caddy?.profiles).toEqual(["https"]);
  });

  test("Tailscale: pinned, its own profile, userspace, logged in once, state kept", () => {
    const tailscale = compose.services.tailscale as {
      image: string;
      profiles: string[];
      environment: Record<string, string>;
      configs: { source: string; target: string }[];
      volumes: string[];
      ports?: unknown;
      cap_add?: unknown;
      devices?: unknown;
    };
    expect(tailscale.image).toMatch(/^tailscale\/tailscale:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
    expect(tailscale.profiles).toEqual(["tailscale"]);
    expect(tailscale.environment).toMatchObject({
      TS_USERSPACE: "true",
      TS_AUTH_ONCE: "true",
      TS_STATE_DIR: "/var/lib/tailscale",
      TS_SERVE_CONFIG: "/config/serve.json",
    });
    expect(tailscale.configs).toEqual([{ source: "tailscale-serve", target: "/config/serve.json" }]);
    expect(tailscale.volumes).toEqual(["tailscale-state:/var/lib/tailscale"]);
    expect("tailscale-state" in compose.volumes).toBe(true);
    expect(tailscale.ports ?? tailscale.cap_add ?? tailscale.devices).toBeUndefined();
  });

  test("the serve config: HTTPS on 443 to the app, Funnel off unless asked", () => {
    // Compose turns $$ into $ and gives the variable its default; the container then fills in its name.
    const content = compose.configs["tailscale-serve"]?.content
      .replaceAll(/\$\$\{TS_CERT_DOMAIN\}/g, "agentes.tail1234.ts.net")
      .replace(/\$\{TAILSCALE_FUNNEL:-false\}/, "false") as string;
    expect(JSON.parse(content)).toEqual({
      TCP: { "443": { HTTPS: true } },
      Web: { "agentes.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://agentes:3000" } } } },
      AllowFunnel: { "agentes.tail1234.ts.net:443": false },
    });
  });
});
