/**
 * Words that are true only in some setups, and the keys allowed to say them. The Cloud runs the self-host image with
 * env vars (ADR 0002), so one string tree serves every setup: a key in no list below is shown everywhere and may hold
 * none of these phrases. A key that holds one is listed under its condition, in the same change as the code that shows
 * it only there.
 */
export type Condition = "cloud" | "selfhost" | "email" | "apiKey" | "routing" | "system";
export type Locale = "en" | "pt-BR";

export const PHRASES: Record<Condition, Record<Locale, readonly RegExp[]>> = {
  /** The Cloud is run by us: our storage, we're on it, a computer that is always on. */
  cloud: {
    en: [/\bour storage\b/i, /\bwe're on it\b/i, /\balways on\b/i, /\bday and night\b/i, /\bagentes storage\b/i],
    "pt-BR": [
      /\bnosso armazenamento\b/i,
      /\bestamos cuidando\b/i,
      /\bsempre ligad/i,
      /\bdia e noite\b/i,
      /\barmazenamento do agentes\b/i,
    ],
  },
  /** Self-host: a server someone runs, computers people connect. */
  selfhost: {
    en: [
      /\bthis server\b/i,
      /\byour (own )?server\b/i,
      /\bconnected computers?\b/i,
      /\bconnect (a|another) computer\b/i,
      /SELF_HOSTING/,
    ],
    "pt-BR": [
      /\b(este|deste|neste) servidor\b/i,
      /\bseu (próprio )?servidor\b/i,
      /\bcomputadores? conectados?\b/i,
      /\bconectar (um|outro) computador\b/i,
      /SELF_HOSTING/,
    ],
  },
  /** Only where the server sends email (`auth-config.passwordReset`). */
  email: {
    en: [/\bwe (sent|emailed)\b/i, /\bwe('ll| will) email\b/i, /\bgets an invitation by email\b/i],
    "pt-BR": [/\bmandamos\b/i, /\bavisamos (você )?(em|por) /i, /\brecebe um convite por e-?mail\b/i],
  },
  /** Only where the workspace has an API key: an answer through the API instead. */
  apiKey: {
    en: [/\b(goes back to|answer through) the API\b/i],
    "pt-BR": [/\b(volta para a|responder pela) API\b/i],
  },
  /** Only where a message nobody mentions still gets an agent (`ai-status.routing`). */
  routing: {
    en: [/\bwithout a mention\b/i, /\bno @ needed\b/i],
    "pt-BR": [/\bsem menção\b/i, /\bsem precisar de @/i],
  },
  /** One system's words: say {{device}} or {{system}}, or list the key with the code that checks the system. */
  system: {
    en: [/\b(this|the) Mac\b/i, /\bfor (the )?Mac\b/i, /\bmenu bar\b/i, /\bFinder\b/, /\bApplications\b/, /\bsudo\b/],
    "pt-BR": [
      /\b(este|neste|deste|desse|esse) Mac\b/i,
      /\bpara (o )?Mac\b/i,
      /\bbarra de menus\b/i,
      /\bFinder\b/,
      /\bAplicativos\b/,
      /\bsudo\b/,
    ],
  },
};

/**
 * Keys (exact, or a prefix ending in ".") each condition gates. A key with a segment ending in `Cloud`
 * (`outage.titleCloud`, `aiAccounts.connect.needsCloud.online`) is the Cloud's without a line here.
 * Help lines are keyed `help.<edition>.<slug>.<path>`, phone keys `mobile.…`, desktop keys `desktop.…`.
 */
export const SHOWN_ONLY: Record<Condition, readonly string[]> = {
  cloud: [
    "computerSetup.",
    "agentComputer.status.problem",
    "agentComputer.status.notAnswering",
    "agentComputer.state.notAnsweringHelp",
    "outage.cloudSub",
    "storage.agentes",
    "storage.agentesText",
    "storage.place.agentes",
    "help.cloud.",
    "mobile.outage.cloudSub",
    "mobile.outage.sheet.cloudTag",
    "mobile.outage.sheet.managedDesc",
    // Shown only on the Cloud, to owners, while email goes out.
    "connectAi.wait.email",
    // The computer step's plan offer: only where the workspace gets its own computer (`setupView`, as
    // `computerSetup.`) and waits for its first plan (ADR 0079).
    "onboarding.computer.payment.",
  ],
  selfhost: [
    "auth.owner.",
    "auth.flow.ownerWaits",
    "auth.flow.ownerWaitsLead",
    "auth.flow.noPasswordLead",
    "access.unavailable",
    "agentPage.computer.unavailable",
    "agentPage.work.browserDialog.noComputer",
    "agentPage.work.computer.connect",
    "aiAccounts.connect.addComputer",
    "aiAccounts.connect.noComputer",
    "brain.reasons.no_computer",
    "browser.inCard.noComputer",
    "browser.live.noComputer",
    "computers.hostMissing",
    "computers.lead",
    "connectAi.key.platform",
    "connectAi.wait.connecting",
    "errors.mission.unavailable",
    "machines.download.step2",
    "machines.download.title",
    "machines.host.",
    "members.requests.copyText",
    "missions.new.connect",
    "missions.new.connectComputer",
    "missions.new.needsMachine",
    "missions.new.noEligibleText",
    "missions.new.reason.no_computer",
    "missions.pinned.noComputers",
    "onboarding.computer.hostConnecting",
    "onboarding.computer.hostReady",
    "onboarding.computer.otherComputer",
    "onboarding.platformKeyDesc",
    "openOnPhone.stepTailscale",
    "outage.dialog.none",
    "settings.platformAvailable",
    "settings.telemetry.",
    "settings.tileState.platformKey",
    "skills.unavailable",
    "storage.server",
    "storage.serverText.",
    "storage.place.server",
    "storage.showFolder",
    // The free space of the disk under this server's files folder: the Cloud keeps none.
    "storage.usage.free",
    "support.ask",
    "help.selfhost.",
    // A server other than the Cloud with no terms or privacy page of its own: the Cloud always shows its documents.
    "legal.none.",
    "mobile.newMission.noAgents",
    "mobile.newMission.reason.no_computer",
    // The Jev card and its setup screen render only for the installation's owner on self-host
    // (GET /api/app/jev is 404 elsewhere).
    "jev.",
    "onboarding.jev.",
    // The GIPHY key's card too, in Settings › GIFs and stickers (GET /api/app/gif-key is 404 elsewhere, ADR 0091).
    "settings.media.giphy.",
    // Deleting: computers people connected, and the person who set up the server, only a self-hosted server has.
    "deleteOrg.goes.computers",
    "deleteAccount.computers_one",
    "deleteAccount.computers_other",
    "deleteAccount.serverOwner",
    // Where no email goes, which the Cloud always sends, a password proves it's you (`deletionProof`).
    "proof.addPassword",
  ],
  email: [
    "auth.newLinkSent",
    "invite.ask.approvedEmail",
    "invite.ask.sentEmail",
    "onboarding.confirmation.sent",
    "onboarding.done.invited_one",
    "onboarding.done.invited_other",
    "onboarding.team.emailsHint",
    "computerSetup.email.",
    "connectAi.wait.email",
    "deleteOrg.goes.people",
    // Deleting's emailed code (`deletionProof`): asked for, sent and refused only where the server sends email.
    "proof.willSend",
    "proof.sent",
    "errors.reauth.code",
  ],
  apiKey: ["agentPage.work.brain.fallbackTitle"],
  // A message nobody mentions still gets an agent: routing.mine (the chip and its help line), routing.by (Settings),
  // or the receipt of a message a rule sent to its one candidate.
  routing: [
    "channel.autoReplyChip",
    "channelMembers.replyAloneHelp",
    "routing.by.jev",
    "routing.by.model",
    "receipts.by.only_agent",
  ],
  system: [
    "wiki.import.howTo",
    "machines.download.step1",
    "help.selfhost.computers.sections.0.blocks.0",
    "desktop.prefs.general.dockDesc",
    "desktop.prefs.general.menuBarTitle",
    "desktop.prefs.updates.",
    "desktop.server.reveal",
    "desktop.cover.tailnetUp",
  ],
};

/** Keys whose server words mean another server (an MCP or database server, one the person picks): every setup. */
export const ANYWHERE: readonly string[] = [
  "connectFlow.needsKey",
  "database.error.blocked_host",
  // "a server that's always on": what to install instead of this computer.
  "help.selfhost.run-on-your-computer.sections.1.blocks.0",
  "mobile.connectors.needsKey",
  "mobile.connectors.review.waiting",
  "mobile.auth.server.",
  "mobile.auth.connect.",
  "desktop.first.",
  "desktop.own.",
  "desktop.connect.",
  "desktop.link.",
  "desktop.servers.",
];

const listed = (key: string, entries: readonly string[]) =>
  entries.some((e) => (e.endsWith(".") ? key.startsWith(e) : key === e));

/** The conditions a key is shown under. */
export function conditionsOf(key: string): Set<Condition> {
  const out = new Set<Condition>();
  for (const c of Object.keys(SHOWN_ONLY) as Condition[]) if (listed(key, SHOWN_ONLY[c])) out.add(c);
  if (key.split(".").some((s) => s.endsWith("Cloud"))) out.add("cloud");
  return out;
}

/** "key: condition /phrase/" for each phrase a key holds outside its conditions. */
export function misplaced(leaves: [string, string][], locale: Locale): string[] {
  const out: string[] = [];
  for (const [key, text] of leaves) {
    const conds = conditionsOf(key);
    const elsewhere = listed(key, ANYWHERE);
    // A phrase kept whole by no-break spaces is still the phrase.
    const words = text.replaceAll("\u00a0", " ");
    for (const c of Object.keys(PHRASES) as Condition[]) {
      if (conds.has(c) || (elsewhere && (c === "cloud" || c === "selfhost"))) continue;
      const hit = PHRASES[c][locale].find((re) => re.test(words));
      if (hit) out.push(`${key}: ${c} ${hit}`);
    }
    if (conds.has("cloud") && conds.has("selfhost")) out.push(`${key}: listed for both editions`);
  }
  return out;
}

/** Registry lines under `prefix` (`mobile.`, `desktop.`, or "" for the shared tree and help) that match no key. */
export function staleLines(keys: readonly string[], prefix: string): string[] {
  const own = (e: string) => (prefix ? e.startsWith(prefix) : !e.startsWith("mobile.") && !e.startsWith("desktop."));
  const entries = [...new Set([...Object.values(SHOWN_ONLY).flat(), ...ANYWHERE])].filter(own);
  return entries.filter((e) => !keys.some((k) => (e.endsWith(".") ? k.startsWith(e) : k === e)));
}
