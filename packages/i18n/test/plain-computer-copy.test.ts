import { describe, expect, test } from "bun:test";
import { en, ptBR } from "../src/index";
import { bannedIn, CLOUD_BANNED, SELFHOST_BANNED, TECHNICAL } from "./edition-words";
import { leaves } from "./leaves";
import { conditionsOf } from "./setups";

/**
 * Screens about the agents' computer (onboarding, preparing, its own page) are read by people who aren't
 * developers: no system names, addresses or tool lists. Sizes ("4 CPUs · 8 GB de memória") and "um usuário
 * para cada agente" are fine. A new screen about computers adds its namespace here; so do the workspace's
 * standing screens (the hold banner, the suspended screen) and where to ask for help, read by the same people.
 */
const NAMESPACES = [
  "onboarding.computer.",
  "computer.",
  "computerSetup.",
  "computers.",
  "agentComputer.",
  "machine.",
  "machines.host.",
  "standing.",
  "support.",
];

/**
 * What the workspace computer's screens say in each state (`setupView`, `SETUP_STAGES`, `etaView` in
 * packages/client/src/lib/computer.ts).
 */
const SETUP_KEYS = [
  ...["reserving", "starting", "installing", "connecting"].map((s) => `computerSetup.step.${s}`),
  ...["ordering", "wiping", "booting", "updating", "restarting", "network", "firewall"].map(
    (s) => `computerSetup.stage.${s}`,
  ),
  ...["preparing", "capacity", "problem", "ready", "paused"].flatMap((s) => [
    `computerSetup.status.${s}`,
    `computerSetup.chip.${s}`,
  ]),
  ...["minutes_one", "minutes_other", "underMinute", "almost", "late"].map((s) => `computerSetup.eta.${s}`),
  "computerSetup.email.you",
  "computerSetup.email.here",
  "computerSetup.email.short",
  "computerSetup.title",
  "computerSetup.specs",
  "computerSetup.users",
  "computerSetup.notice.title",
  "computerSetup.agentWaiting",
  "computer.target.none",
  "standing.onHold",
  "standing.paused",
  "standing.bannerSub",
  "standing.screen.title",
  "support.writeBefore",
  "support.ask",
];

/** `agentComputer.` keys only self-host shows: its computers are people's own, connected with a code. */
const SELFHOST_ONLY = [
  "agentComputer.choose",
  "agentComputer.status.offline",
  "agentComputer.status.paused",
  "agentComputer.status.pausedPlain",
  "agentComputer.status.noComputer",
  "agentComputer.status.noBrowser",
  "agentComputer.status.outdated",
  "agentComputer.sub.offline",
  "agentComputer.state.paused",
  "agentComputer.state.pausedPlain",
  "agentComputer.state.offline",
  "agentComputer.state.offlineHelpPlain",
  "agentComputer.state.screensOff",
  "agentComputer.state.screensMissing",
  "agentComputer.state.outdated",
  "agentComputer.state.noComputer",
  "agentComputer.state.browserOff",
  "agentComputer.phone.chooseOnWeb",
];

/**
 * "Responde a todos", its line and its ⓘ (ADR 0059 §5): beside every plan's sign-in and on every agent's page on a
 * plan, the Cloud's included, so they're checked against both editions' words.
 */
const PLAN_REPLIES = [
  "aiAccounts.share.switch",
  "aiAccounts.share.switchAll",
  "aiAccounts.share.switchOther",
  "aiAccounts.share.onOther",
  ...["line", "linePlan", "own", "seat", "other"].map((k) => `aiAccounts.share.terms.${k}`),
];

/** Every key a Cloud workspace shows where a computer is named, past the `computerSetup.` and `agentComputer.` ones. */
const CLOUD_EXTRA = [
  ...PLAN_REPLIES,
  "desktop.sub.control",
  "desktop.sub.controlAsked",
  "desktop.sub.hidden",
  "desktop.takeover",
  ...["handBack", "done", "couldnt", "full", "fullExit", "closed", "closedHelp", "offlineCloud", "noComputerCloud"].map(
    (k) => `browser.inCard.${k}`,
  ),
  "desktop.state.busy",
  "desktop.state.ended",
  "desktop.state.retrying",
  "desktop.retry",
  "browser.now.handedBack",
  "desktop.control.keys",
  "desktop.control.notice",
  "desktop.watch.notice",
  "desktop.session.check",
  "desktop.session.screening",
  "desktop.keyboard.field",
  "desktop.keyboard.label",
  ...["got", "copied", "tooLong", "textOnly"].map((k) => `desktop.clipboard.${k}`),
  "computers.leadCloud",
  "computers.about",
  "agentPage.work.cell.computer",
  "agentPage.work.offlineCloud",
  "agentPage.work.brain.fallbackTitle",
  "agentPage.work.brain.fallbackHint",
  "agentPage.work.brain.add.stepOneHint",
  "aiAccounts.page.hint",
  "agentPage.work.brain.offCloud",
  "missions.settings.more.sub",
  "missions.settings.recovery.title",
  "onboarding.budget.noteKey",
  "onboarding.computer.leadCloud",
  "onboarding.computer.leadCloudPaused",
  "onboarding.keyStep.lead",
  ...["ready", "waiting", "noAi", "noAiAny"].map((k) => `onboarding.done.first.${k}`),
  ...["signIn", "key", "email", "ready", "useKey"].map((k) => `connectAi.wait.${k}`),
  "connectAi.each",
  "connectAi.eachHint",
  "connectAi.titleFor",
  "agentPage.work.brain.add.startFailed",
  "agentPage.work.brain.add.duplicate.claude_code",
  "agentPage.work.brain.add.duplicate.codex",
  "connectAi.otherAccount.claude_code",
  "connectAi.otherAccount.codex",
  "connectAi.useAnyway",
  "outage.titleCloud",
  "outage.cloudSub",
  "aiAccounts.connect.needsCloud.claude_code",
  "aiAccounts.connect.needsCloud.codex",
  "aiAccounts.connect.needsCloud.online",
  "agentPage.work.browserDialog.noComputerCloud",
  "brain.reasons.no_computerCloud",
  "scopes.browser_use.description",
  "access.areaText.browser.write",
  "missions.subtitle",
  "threads.empty.missions",
  "missions.share.lendText",
  "missions.waitingCloud",
];

/** The same screens' self-host keys, past the `agentComputer.` ones. */
const SELFHOST_EXTRA = [
  ...PLAN_REPLIES,
  "computers.lead",
  "browser.inCard.offline",
  "browser.inCard.noComputer",
  "computers.hostMissing",
  ...["title", "text", "emptyTitle"].map((k) => `computers.other.${k}`),
  "computers.how",
  "computers.daytona.cardTitle",
  "computers.cloud.note",
  "computers.agents.title",
  "machines.host.label",
  "machines.host.desc",
  "machines.host.descUsers",
  "machines.host.descShared",
  "machines.download.title",
  "machines.pausedHint",
  "outage.switch",
  "outage.title",
  "outage.dialog.cloud",
  "outage.dialog.cloudText",
  "computer.target.none",
  "computer.target.daytona",
  "computer.target.daytonaText",
  "computer.emptyText",
  "computer.machineOffline",
  "desktop.use.title",
  "agentPage.work.offline",
  "agentPage.work.brain.off",
  "agentPage.work.computer.offline",
  "agentPage.work.computer.alsoOffline",
  "agentPage.work.computer.connect",
  "agentPage.work.cell.daytona",
  "agentPage.work.saved.daytona",
  "agentPage.work.saved.none",
  "agentPage.work.computer.useDaytona",
  "agentPage.computer.ownerPicks",
  ...["mine", "mineDesc", "cloud", "cloudDesc", "cloudReady"].map((k) => `onboarding.computer.${k}`),
  "onboarding.keyStep.leadNoComputer",
  "onboarding.brain.failed",
  "connectAi.wait.connecting",
  ...["shared", "one"].map((k) => `connectAi.own.${k}`),
  "usageViews.agent.sharedPart",
  "agentPage.work.brain.add.duplicate.claude_code",
  "agentPage.work.brain.add.duplicate.codex",
  "connectAi.otherAccount.claude_code",
  "connectAi.otherAccount.codex",
  "connectAi.useAnyway",
  "aiAccounts.connect.needs.keys",
  "aiAccounts.connect.noComputer",
  "aiAccounts.connect.addComputer",
];

const LOCALES = [
  ["pt-BR", ptBR],
  ["en", en],
] as const;

const valuesOf = (strings: object) => new Map(leaves(strings).map(([k, v]) => [k, String(v)]));

/** The Cloud's keys and the self-host's, in one locale. */
function editionKeys(strings: object) {
  const all = [...valuesOf(strings).keys()];
  const computer = all.filter((k) => k.startsWith("agentComputer."));
  const cloud = [
    ...all.filter((k) => k.startsWith("computerSetup.")),
    ...computer.filter((k) => !SELFHOST_ONLY.includes(k)),
    ...CLOUD_EXTRA,
  ];
  return { cloud, selfhost: [...computer, ...SELFHOST_EXTRA] };
}

/** Each key with the banned phrases its value holds, only those that hold some. */
function hitsOf(values: Map<string, string>, keys: string[], phrasesOf: (key: string) => readonly string[]) {
  return keys.map((k) => [k, bannedIn(values.get(k) ?? "", phrasesOf(k))] as const).filter(([, f]) => f.length > 0);
}

describe("computer copy", () => {
  for (const [locale, strings] of LOCALES) {
    test(`${locale} names no system, address or tool`, () => {
      const copy = leaves(strings).filter(([k]) => NAMESPACES.some((n) => k.startsWith(n)));
      expect(copy.length).toBeGreaterThan(0);
      expect(copy.filter(([, v]) => TECHNICAL.test(String(v)))).toEqual([]);
    });

    test(`${locale}: the Cloud's computer is always on, nobody pairs one, and it isn't in the cloud`, () => {
      const values = valuesOf(strings);
      const { cloud } = editionKeys(strings);
      expect(cloud.filter((k) => !values.has(k))).toEqual([]);
      expect(hitsOf(values, cloud, () => CLOUD_BANNED[locale])).toEqual([]);
    });

    test(`${locale}: no stage opens with a step's word, so the computer never reads as starting twice`, () => {
      const values = valuesOf(strings);
      const first = (k: string) => values.get(k)?.split(" ")[0];
      const of = (prefix: string) => [...values.keys()].filter((k) => k.startsWith(prefix));
      const steps = of("computerSetup.step.").map(first);
      expect(of("computerSetup.stage.").filter((k) => steps.includes(first(k)))).toEqual([]);
    });

    test(`${locale}: self-host never says the cloud, and its computer's dialog never says terminal`, () => {
      const values = valuesOf(strings);
      const { selfhost } = editionKeys(strings);
      expect(selfhost.filter((k) => !values.has(k))).toEqual([]);
      const phrases = (k: string) =>
        k.startsWith("agentComputer.") ? [...SELFHOST_BANNED, "terminal"] : SELFHOST_BANNED;
      expect(hitsOf(values, selfhost, phrases)).toEqual([]);
    });
  }

  test("the workspace computer's states and the standing screens have words, all of them checked here", () => {
    for (const strings of [ptBR, en]) {
      const keys = new Set(leaves(strings).map(([k]) => k));
      expect(SETUP_KEYS.filter((k) => !keys.has(k))).toEqual([]);
      expect(SETUP_KEYS.filter((k) => !NAMESPACES.some((n) => k.startsWith(n)))).toEqual([]);
    }
  });

  test("no terminal view and no wait for an approval are left to say", () => {
    for (const strings of [ptBR, en]) {
      const keys = [...valuesOf(strings).keys()];
      expect(keys.filter((k) => k.startsWith("terminal.") || k.startsWith("computers.kinds."))).toEqual([]);
      expect(keys.filter((k) => k.startsWith("computerSetup.") && k.endsWith(".approval"))).toEqual([]);
    }
  });

  test("the account choice says who shares the sign-in, never which computer it is on", () => {
    // Shown only where the person connected the computer (the server's own, a computer of theirs), never on the
    // Cloud's: words that name no computer and no sign-in are true on each. Someone with agents on two such computers
    // sees one shared account on each, so it never claims to be every agent's.
    for (const strings of [ptBR, en]) {
      const values = valuesOf(strings);
      const choice = ["own.shared", "own.one"].map((k) => values.get(`connectAi.${k}`) ?? "");
      const shared = [values.get("connectAi.own.shared") ?? "", values.get("usageViews.agent.sharedPart") ?? ""];
      expect([...choice, ...shared].every(Boolean)).toBe(true);
      const placed = /\{\{(computer|brand)\}\}|comput|login|signed in|outra|another/i;
      expect([...choice, ...shared].filter((v) => placed.test(v))).toEqual([]);
      expect(shared.filter((v) => /\ball\b|\btod[oa]s\b/i.test(v))).toEqual([]);
      // The usage sentence says the same name.
      expect(shared[1]?.toLowerCase()).toContain((shared[0] ?? "").replace(/^(the|a) /i, "").toLowerCase());
    }
    expect(SELFHOST_EXTRA).toEqual(
      expect.arrayContaining(["connectAi.own.shared", "connectAi.own.one", "usageViews.agent.sharedPart"]),
    );
    expect(CLOUD_EXTRA.filter((k) => k.startsWith("connectAi.own.") || k === "usageViews.agent.sharedPart")).toEqual(
      [],
    );
  });

  test("an agent on a plan replies to everyone once its owner says so: nothing to accept, the terms a gray area", () => {
    for (const strings of [ptBR, en]) {
      const values = valuesOf(strings);
      const words = PLAN_REPLIES.map((k) => values.get(k) ?? "");
      expect(words.every(Boolean)).toBe(true);
      // No risk to take on, nothing to accept or confirm, no rule that a plan only answers its owner.
      expect(words.filter((v) => /risk|risco|accept|aceit|confirm|personal|pessoal/i.test(v))).toEqual([]);
      // The line under the switch is a few words; its ⓘ says what the terms say.
      for (const k of ["line", "linePlan"])
        expect((values.get(`aiAccounts.share.terms.${k}`) ?? "").split(" ").length).toBeLessThanOrEqual(7);
      // Nothing is left of the confirmation, the fixed note or the refusal they replace.
      const gone =
        /^aiAccounts\.share\.(title|body|accept|keep|fixedHint|hint)\b|^connectAi\.(onlyYou|foot)\b|^connectAi\.own\.note$|^aiAccounts\.errors\.plan(Personal|TermsRequired)$/;
      expect([...values.keys()].filter((k) => gone.test(k))).toEqual([]);
    }
  });

  test("'responde a' only says whom an agent replies to: its header names its owner as whose it is", () => {
    // The header sits over the page with "Responde a todos", where "responde a Lucas" would read as whom it replies to.
    for (const [strings, replies] of [
      [ptBR, /\bresponde a\b/i],
      [en, /\b(answers|replies) to\b/i],
    ] as const) {
      const headers = [...valuesOf(strings)].filter(([, v]) => v.startsWith("{{role}} ·") && v.includes("{{owner}}"));
      expect(headers.map(([k]) => k)).toEqual(["dm.subtitle", "agent.subtitle"]);
      expect(headers.filter(([, v]) => replies.test(v))).toEqual([]);
    }
  });

  test("the storage line says what the files take, and where only for this server's disk, the one place it shows", () => {
    // Every setup shows how much (the Cloud, a server's folder or database, a bucket), and each option's own words say
    // where: only a folder on this server adds what its disk has free.
    const place = /disk|disco|serv|bucket|database|banco|cloud|nuvem|storage|armazenamento/i;
    for (const strings of [ptBR, en]) {
      const values = valuesOf(strings);
      const [files = "", none = "", free = ""] = ["files", "none", "free"].map((k) => values.get(`storage.usage.${k}`));
      expect([files, none, free].filter((v) => !v || TECHNICAL.test(v))).toEqual([]);
      expect([files, none].filter((v) => place.test(v))).toEqual([]);
      expect(free).toMatch(place);
    }
    expect([...conditionsOf("storage.usage.free")]).toEqual(["selfhost"]);
    expect([...conditionsOf("storage.usage.files"), ...conditionsOf("storage.usage.none")]).toEqual([]);
  });

  test("catches the words it bans, whatever the case", () => {
    for (const s of ["Um Linux só do workspace", "com ip próprio", "4 vCPU", "Chrome, git, Node", "IPv4"]) {
      expect(TECHNICAL.test(s)).toBe(true);
    }
    for (const s of ["4 CPUs · 8 GB de memória", "Um usuário para cada agente", "Go to settings", "a equipe"]) {
      expect(TECHNICAL.test(s)).toBe(false);
    }
    for (const s of [
      "Your computer is off right now",
      "Connect a computer",
      "It turns on by itself",
      "Pair it",
      "Turning it on",
    ]) {
      expect(bannedIn(s, CLOUD_BANNED.en).length).toBeGreaterThan(0);
    }
    for (const s of ["Seu computador está desligado", "Na nuvem", "Ela liga sozinha", "Abrir o Terminal", "Ligando"]) {
      expect(bannedIn(s, CLOUD_BANNED["pt-BR"]).length).toBeGreaterThan(0);
    }
    for (const s of ["Always on, day and night", "Sempre ligado, dia e noite", "Not answering · we're on it"]) {
      expect(bannedIn(s, [...CLOUD_BANNED.en, ...CLOUD_BANNED["pt-BR"]])).toEqual([]);
    }
    expect(bannedIn("Cloud computer", SELFHOST_BANNED)).toEqual(["cloud computer"]);
    expect(bannedIn("Sandbox da Daytona", SELFHOST_BANNED)).toEqual([]);
  });
});
