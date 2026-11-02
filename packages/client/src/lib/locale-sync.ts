import { type AppLocale, isAppLocale } from "@agenteschat/i18n/locale";
import { useEffect, useRef } from "react";

/** What a device keeps: the language it shows (or "auto", this device's own) and whether the server has yet to hear it. */
export interface LocaleState {
  stored: AppLocale | "auto" | null;
  /** Picked on this device while signed out (the sign-in page's picker): the next sign-in sends it. */
  pending: boolean;
}

/**
 * Once signed in, the language every device of the person shows (ADR 0121). A pick on this device the server hasn't
 * heard wins and is sent; else a language the person picked anywhere (`localeAuto` false) wins; else each device
 * follows its own (`detected`), and the server keeps the last one detected for emails and pushes.
 */
export function localeSync(input: {
  state: LocaleState;
  detected: AppLocale;
  server: { locale?: string | null; localeAuto?: boolean };
}): { use: AppLocale; store: AppLocale | "auto"; patch?: { locale: AppLocale; auto: boolean } } {
  const { state, detected, server } = input;
  if (state.pending && state.stored && state.stored !== "auto")
    return { use: state.stored, store: state.stored, patch: { locale: state.stored, auto: false } };
  if (!state.pending && server.localeAuto === false && isAppLocale(server.locale))
    return { use: server.locale, store: server.locale };
  return {
    use: detected,
    store: "auto",
    ...(server.locale !== detected || server.localeAuto === false ? { patch: { locale: detected, auto: true } } : {}),
  };
}

/** Runs `localeSync` once per signed-in person, when their `/me` arrives. */
export function useLocaleSync(opts: {
  user: { id: string; locale?: string | null; localeAuto?: boolean } | null | undefined;
  read: () => LocaleState;
  detected: () => AppLocale;
  apply: (code: AppLocale, store: AppLocale | "auto") => void;
  send: (patch: { locale: AppLocale; auto: boolean }) => Promise<unknown>;
}) {
  const done = useRef<string | null>(null);
  const latest = useRef(opts);
  latest.current = opts;
  const { user } = opts;
  useEffect(() => {
    if (!user || done.current === user.id) return;
    done.current = user.id;
    const { read, detected, apply, send } = latest.current;
    const next = localeSync({ state: read(), detected: detected(), server: user });
    apply(next.use, next.store);
    // Not sent: the next sign-in tries again (emails stay in the last language the server heard).
    if (next.patch) send(next.patch).catch(() => {});
  }, [user]);
}
