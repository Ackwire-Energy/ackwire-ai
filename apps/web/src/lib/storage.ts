const safe = (area: () => Storage) => ({
  get(key: string): string | null {
    try {
      return area().getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      area().setItem(key, value);
    } catch {
      // Not persisted.
    }
  },
  remove(key: string) {
    try {
      area().removeItem(key);
    } catch {
      // Ignore.
    }
  },
});

/** localStorage that never throws (private mode, blocked storage). */
export const storage = safe(() => localStorage);
/** sessionStorage (this tab only), the same way. */
export const sessionStore = safe(() => sessionStorage);

/** The JSON list of strings saved under `key` in `storage` (nothing, or anything else saved there: empty). */
export function storedStrings(key: string): string[] {
  try {
    const v = JSON.parse(storage.get(key) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export const STORAGE_KEYS = {
  theme: "agentes.theme",
  lastOrg: "agentes.lastOrg",
  /** The last page shown in each workspace (JSON, by workspace id): where "Onde você parou" opens (ADR 0108). */
  lastPlace: "agentes.lastPlace",
  /** Workspaces whose "Primeiros passos" the person hid on Início (JSON array of ids). */
  firstStepsHidden: "agentes.home.stepsHidden",
  /** How this browser signed in last ("google", "github", "apple" or "email"): marked on the sign-in screen. */
  lastSignIn: "agentes.lastSignIn",
  /** The Drive's view: "grid" (default) or "list". */
  driveView: "agentes.drive.view",
  /** "1" when the person shrank the sidebar to its icon rail (desktop). */
  sidebarCollapsed: "agentes.sidebar.collapsed",
  /** Prefix (`.<user id>.<org id>`): the sidebar categories that person closed in that workspace (JSON array of ids). */
  sidebarSections: "agentes.sidebar.sections",
  /** Offline-computer notices the person closed (`machineId@offlineSince`), until that computer comes back. */
  outagesDismissed: "agentes.outages.dismissed",
  /** The workspace computer's notice the person closed (`setupNoticeKey`), until its state changes. */
  setupNoticeHidden: "agentes.setup.hidden",
  /** The desktop app's right click: "ours" (default) or "system" (lib/context-menu.ts). */
  menuLook: "agentes.desktop.menu",
  /** Prefix (`.<message id>`, in `sessionStore`): the Connect dialog already opened by itself for that message. */
  noAiOpened: "agentes.noAi.opened",
  /** Prefix (`.<orgId>`, in `sessionStore`): the agents the onboarding imported there, with their models (JSON). */
  onboardingImports: "agentes.onboarding.imports",
  /** In `sessionStore`: the address this tab signed up with, when the server emailed it a confirmation link. */
  confirmationSent: "agentes.confirmation.sent",
  /** In `sessionStore`: my messages waiting for the connection (the shared `outbox`), kept through a reload. */
  outbox: "agentes.outbox",
  /** The app's sounds on this device: "tactile" (default), "sky", "pixel" or "off" (lib/sounds.ts). */
  sounds: "agentes.sounds",
  /** In `sessionStore`, this tab's id; in `storage`, the tab the person used last (it plays sounds while hidden). */
  soundTab: "agentes.sounds.tab",
  /** How many times the notifications dialog opened by itself in this browser (`WebPushAsk`, ADR 0071). */
  pushOffers: "agentes.push.offers",
  /** In `sessionStore`: when the boot last reloaded because the app's files didn't load (index.html keeps a copy). */
  bootRetry: "agentes.bootRetry",
  /** In `sessionStore`: when the app last reloaded into a new version (`reloadForNewVersion`). */
  versionReload: "agentes.versionReload",
  /**
   * Prefix (`.<invitation token>`, in `sessionStore`): the request this tab made through an invitation link, its key,
   * name and email as JSON, so a reload keeps waiting for the answer (ADR 0090).
   */
  joinAsked: "agentes.join.asked",
  /** Prefix (`.<user id>.<org id>`): "1" once a newcomer closed their welcome in #general (ADR 0090). */
  arrivalClosed: "agentes.arrival.closed",
} as const;
