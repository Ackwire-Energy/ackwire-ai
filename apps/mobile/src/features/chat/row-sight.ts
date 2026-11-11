import { type Band, cardShows, type Measurable } from "./ask-store";

/**
 * Which agents' live rows are on screen, without React Native, so it is unit-tested. The line above the composer
 * leaves out an agent whose row shows (the row says its step, its time and its stop) and speaks for one whose row is
 * out of view, as on the web. The rows register their views while drawn; the screen measures them against the
 * list's band (below the floating header, above the composer and the keyboard) and says which show. A row not drawn
 * (no words of its own yet, or outside what the list keeps mounted) is out of view.
 */
export class RowSight {
  private rows = new Map<string, Measurable>();
  /** The runs the screen last found on screen. */
  private shown = new Set<string>();
  /** The screen looked at least once: before that a drawn row counts as on screen, so the line never flashes. */
  private measured = false;
  private inView: ReadonlySet<string> = new Set();
  private listeners = new Set<() => void>();
  private watchers = new Set<() => void>();

  /** Hears when the set of rows on screen changes. */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The runs whose rows are on screen: the same set until it changes. */
  getInView = (): ReadonlySet<string> => this.inView;

  /** Hears when a row is drawn or goes: the screen looks again. */
  watch(watcher: () => void) {
    this.watchers.add(watcher);
    return () => {
      this.watchers.delete(watcher);
    };
  }

  hasRows() {
    return this.rows.size > 0;
  }

  drawn(): [runId: string, view: Measurable][] {
    return [...this.rows];
  }

  /** A run's live row is drawn; returns the call that takes it back when it goes. */
  register(runId: string, view: Measurable) {
    this.rows.set(runId, view);
    this.publish();
    this.changed();
    return () => {
      if (this.rows.get(runId) !== view) return;
      this.rows.delete(runId);
      this.publish();
      this.changed();
    };
  }

  /** The screen's look: the runs whose rows show in the band. */
  setShown(runIds: Iterable<string>) {
    this.shown = new Set(runIds);
    this.measured = true;
    this.publish();
  }

  private publish() {
    const next = new Set([...this.rows.keys()].filter((id) => !this.measured || this.shown.has(id)));
    if (next.size === this.inView.size && [...next].every((id) => this.inView.has(id))) return;
    this.inView = next;
    for (const listener of this.listeners) listener();
  }

  private changed() {
    for (const watcher of this.watchers) watcher();
  }
}

/**
 * The runs whose rows show in the band, from where each row sits in the window (`y`, `height`): the requests' rule
 * (`cardShows`), 40 points of a row or all of a smaller one.
 */
export function rowsShown(rows: readonly { runId: string; y: number; height: number }[], band: Band): string[] {
  return rows.filter((r) => cardShows(r.y, r.height, band)).map((r) => r.runId);
}
