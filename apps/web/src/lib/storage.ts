/** localStorage that never throws (private mode, blocked storage). */
export const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Not persisted.
    }
  },
  remove(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Ignore.
    }
  },
};

export const STORAGE_KEYS = {
  theme: "agentes.theme",
  lastOrg: "agentes.lastOrg",
  /** The email the visitor put on the landing page's waiting list. */
  waitlist: "agentes.waitlist",
  /** Set once the visitor opened the link in the confirmation email. */
  waitlistConfirmed: "agentes.waitlist.confirmed",
  /** The Drive's view: "grid" (default) or "list". */
  driveView: "agentes.drive.view",
} as const;
