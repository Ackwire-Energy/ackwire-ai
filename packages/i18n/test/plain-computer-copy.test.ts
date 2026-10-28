import { describe, expect, test } from "bun:test";
import { en, ptBR } from "../src/index";
import { bannedIn, CLOUD_BANNED, SELFHOST_BANNED, TECHNICAL } from "./edition-words";
import { leaves } from "./leaves";

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
  "agentComputer.sub.paused",
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

/** Every key a Cloud workspace shows where a computer is named, past the `computerSetup.` and `agentComputer.` ones. */
const CLOUD_EXTRA = [
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
  "connectAi.foot.signIn",
  "connectAi.each",
  "connectAi.eachHint",
  "aiAccounts.share.fixedHint",
  "connectAi.titleFor",
  "agentPage.work.brain.add.startFailed",
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
  ...["this", "thisText", "other", "note"].map((k) => `connectAi.own.${k}`),
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
