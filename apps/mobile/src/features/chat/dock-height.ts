/**
 * The conversation's dock height (the composer's box with the lines over it), kept outside the screen's state: what is
 * drawn from it (the keyboard's gesture area, an empty conversation's greeting, the skeleton) redraws alone when it
 * changes, never the whole conversation, which a field growing a line or the working line coming and going redrew each
 * time. Pure, so it is tested without a screen.
 */
export interface DockHeight {
  get(): number;
  /** The box's height as it was just laid out; nobody is told when it is the same. */
  set(height: number): void;
  subscribe(listener: () => void): () => void;
}

export function createDockHeight(): DockHeight {
  let height = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => height,
    set(next) {
      if (next === height) return;
      height = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
