import type { ControlAgent } from "@agenteschat/adapters/runner-control";
import { useCallback, useEffect, useRef, useState } from "react";
import { useHost } from "./app";
import type { Home } from "./control/store";
import {
  CHECK_EVERY_MS,
  type LatestRelease,
  latestUrl,
  parseLatest,
  type UpdateState,
  updateStateOf,
} from "./control/version";
import type { AppInfo, WindowName } from "./host/types";

/** The app's version and the Mac's arch (from the shell). */
export function useAppInfo(): AppInfo | null {
  const host = useHost();
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    let live = true;
    host
      .appInfo()
      .then((i) => live && setInfo(i))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [host]);
  return info;
}

export interface UpdateCheck {
  state: UpdateState;
  checkedAt: number | null;
  checking: boolean;
  failed: boolean;
  check: () => Promise<UpdateState | null>;
  version: string | null;
}

/**
 * The "Versão nova" check against our server (ADR 0036 §9). `auto`: at start and every 6 hours
 * (the popover window, which owns the tray icon); otherwise only when asked (Preferences).
 */
export function useUpdateCheck(auto: boolean): UpdateCheck {
  const info = useAppInfo();
  const [latest, setLatest] = useState<LatestRelease | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const version = info?.version ?? null;
  const arch = info?.arch ?? null;

  const check = useCallback(async (): Promise<UpdateState | null> => {
    if (!version || !arch) return null;
    setChecking(true);
    setFailed(false);
    try {
      const res = await fetch(latestUrl(arch), { headers: { accept: "application/json" } });
      // 404: no release published yet (or the server can't read them): nothing to offer.
      const found = res.ok ? parseLatest(await res.json()) : null;
      if (!res.ok && res.status !== 404) throw new Error(String(res.status));
      setLatest(found);
      setCheckedAt(Date.now());
      return updateStateOf(version, found);
    } catch {
      setFailed(true);
      return null;
    } finally {
      setChecking(false);
    }
  }, [version, arch]);

  useEffect(() => {
    if (!auto || !version) return;
    void check();
    const timer = setInterval(() => void check(), CHECK_EVERY_MS);
    return () => clearInterval(timer);
  }, [auto, version, check]);

  return { state: updateStateOf(version ?? "0.0.0", latest), checkedAt, checking, failed, check, version };
}

/** Runs `fn` whenever the shell brings this window up. */
export function useOnShown(name: WindowName, fn: () => void) {
  const host = useHost();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(
    () =>
      host.onShown((shown) => {
        if (shown === name) ref.current();
      }),
    [host, name],
  );
}

/** The agent's look from its organization's agents list (jobs and requests carry only id and name). */
export function agentOf(home: Home | undefined, agent: { id: string; name: string }): ControlAgent {
  const known = home?.status?.agents.find((a) => a.id === agent.id);
  return known ?? { id: agent.id, handle: agent.name.toLowerCase(), name: agent.name };
}

/** A small per-viewer preference kept in the web view's storage (survives restarts). */
export function usePref<T>(key: string, fallback: T): [T, (value: T) => void] {
  const read = (): T => {
    try {
      const raw = localStorage.getItem(`agentes.desktop.${key}`);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  };
  const [value, setValue] = useState<T>(read);
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(`agentes.desktop.${key}`, JSON.stringify(v));
      } catch {
        // Not kept; still applies now.
      }
    },
    [key],
  );
  return [value, set];
}

export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`agentes.desktop.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writePref<T>(key: string, value: T) {
  try {
    localStorage.setItem(`agentes.desktop.${key}`, JSON.stringify(value));
  } catch {
    // ignore
  }
}
