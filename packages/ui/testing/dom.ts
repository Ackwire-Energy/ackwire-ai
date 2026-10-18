/**
 * A browser DOM (happy-dom) for unit tests, shared by `packages/ui` and
 * `apps/web`.
 *
 * Backend tests run in the same `bun test` process, and some of their
 * dependencies change behaviour when they see a browser (PGlite looks for
 * `window`). So the DOM is attached only while a DOM test file runs:
 *
 * - the root `bunfig.toml` preloads `testing/preload.ts`, which attaches the
 *   DOM, evaluates the DOM-sensitive libraries once (React DOM, Radix,
 *   Testing Library, TanStack Router read `window`/`document` when they load),
 *   then detaches it again (`testing/preload-done.ts`);
 * - each DOM test file calls `setupDom()`, which attaches it in `beforeAll` and
 *   detaches it in `afterAll`.
 *
 * Bun's own networking, streams, timers, crypto and encoding globals are
 * never replaced.
 */
import { afterAll, beforeAll } from "bun:test";
import { Window } from "happy-dom";

const KEEP_NATIVE = new Set([
  "fetch",
  "Request",
  "Response",
  "Headers",
  "FormData",
  "WebSocket",
  "URL",
  "URLSearchParams",
  "AbortController",
  "AbortSignal",
  "Blob",
  "File",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "TextEncoder",
  "TextDecoder",
  "crypto",
  "performance",
  "console",
  "MessageChannel",
  "MessagePort",
  "BroadcastChannel",
  "Worker",
  "WebAssembly",
]);

/** Globals that Bun also defines (or that backend code probes) and that must be happy-dom's during a DOM test. */
const SWAPPED = [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "localStorage",
  "sessionStorage",
  "Event",
  "EventTarget",
  "CustomEvent",
  "MessageEvent",
  "ErrorEvent",
  "CloseEvent",
] as const;

type Store = Record<string, unknown>;
const g = globalThis as unknown as Store;

interface DomState {
  window: Window;
  native: Map<string, PropertyDescriptor | undefined>;
  attached: boolean;
}

function state(): DomState {
  const existing = g.__agentesDom as DomState | undefined;
  if (existing) return existing;
  const window = new Window({ url: "http://localhost:3000/", width: 1280, height: 900 });
  const w = window as unknown as Store;
  // DOM classes and helpers Bun doesn't have are installed once and stay
  // (harmless for backend code, which never looks for them).
  for (const key of Object.getOwnPropertyNames(window)) {
    if (KEEP_NATIVE.has(key) || key.startsWith("_") || key in globalThis) continue;
    if ((SWAPPED as readonly string[]).includes(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(window, key);
    if (!descriptor) continue;
    try {
      Object.defineProperty(globalThis, key, { ...descriptor, configurable: true });
    } catch {
      // Ignore properties the runtime refuses.
    }
  }
  // Layout APIs happy-dom lacks and Radix calls.
  const proto = window.HTMLElement.prototype as unknown as Store;
  proto.scrollIntoView ??= () => {};
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => {};
  proto.setPointerCapture ??= () => {};
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  w.ResizeObserver ??= NoopResizeObserver;
  g.ResizeObserver ??= w.ResizeObserver;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  const native = new Map<string, PropertyDescriptor | undefined>();
  for (const key of SWAPPED) native.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const created: DomState = { window, native, attached: false };
  g.__agentesDom = created;
  return created;
}

/** The happy-dom window used by every DOM test. */
export const domWindow = () => state().window;

export function attachDom() {
  const s = state();
  if (s.attached) return;
  const w = s.window as unknown as Store;
  for (const key of SWAPPED) {
    const value = key === "window" ? s.window : w[key];
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  s.attached = true;
}

export function detachDom() {
  const s = state();
  if (!s.attached) return;
  for (const key of SWAPPED) {
    const descriptor = s.native.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete g[key];
  }
  s.attached = false;
}

/** Call at the top level of every DOM test file. */
export function setupDom() {
  beforeAll(attachDom);
  afterAll(async () => {
    s().window.document.body.innerHTML = "";
    // Let React's scheduler finish work queued by the file's last test (it runs on a MessageChannel
    // task and reads `window.event`); detaching first made it throw "window is not defined" between
    // files, now and then.
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    detachDom();
  });
}

const s = state;
