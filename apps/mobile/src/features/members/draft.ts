import type { InviteLinkTtl } from "@agenteschat/client";
import { INVITE_LINK_TTL, type InviteStart } from "@agenteschat/client/lib/invite-start";
import { INVITE_NOTE_MAX } from "@agenteschat/client/lib/join-requests";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { InviteAddress } from "./logic";

/**
 * A form that says what someone gets on joining (ADR 0184): Convidar pessoas, Editar link, Editar convite and a
 * request's approval. The cargos are `roleIds`; the channels and agents are those cargos' own (`inviteStart`), with
 * `added` and less `removed`, so picking another cargo brings its own in and the ones taken out stay out.
 */
export interface InviteDraft {
  addresses: InviteAddress[];
  roleIds: string[];
  added: InviteStart;
  removed: InviteStart;
  /** Recado no e-mail. */
  note: string;
  /** Validade; null keeps the link's own date (Editar link's "Até 13 de dez."). */
  expiresIn: InviteLinkTtl | null;
  /** Máximo de pessoas; null: no limit. */
  maxUses: number | null;
  /** Editar link: when it ends as it is, and the people it took (no maximum below them is offered). */
  until?: string;
  uses?: number;
}

const NONE: InviteStart = { channelIds: [], agentIds: [] };

/** Recado no e-mail's size: past it nothing is cut, and Convidar waits (`overLimit`). */
export const INVITE_NOTE_LIMIT = { max: INVITE_NOTE_MAX };

export const EMPTY_INVITE: InviteDraft = {
  addresses: [],
  roleIds: [],
  added: NONE,
  removed: NONE,
  note: "",
  expiresIn: INVITE_LINK_TTL,
  maxUses: null,
};

/**
 * The open forms by key ("invite", `link:{id}`, `invitation:{id}`, `request:{id}`), shared with the pickers pushed
 * over them, as Conta shares its own with Fuso: each form starts its draft and drops it when it closes; a picker
 * writes to the draft its route names and goes back.
 */
const drafts = new Map<string, InviteDraft>();
const listeners = new Set<() => void>();

export function setInviteDraft(key: string, next: InviteDraft | null) {
  if (next) drafts.set(key, next);
  else drafts.delete(key);
  for (const listener of listeners) listener();
}

/** A change to an open form; nothing once it closed. */
export function updateInviteDraft(key: string, change: (draft: InviteDraft) => InviteDraft) {
  const draft = drafts.get(key);
  if (draft) setInviteDraft(key, change(draft));
}

export function useInviteDraft(key: string): InviteDraft | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => drafts.get(key) ?? null,
  );
}

/**
 * A form's draft, started once when what it edits has loaded (`start` is null until then) and dropped when the form
 * goes: what loads again later never undoes a change made meanwhile.
 */
export function useDraftStart(key: string, start: (() => InviteDraft) | null) {
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !start) return;
    started.current = true;
    setInviteDraft(key, start());
  }, [key, start]);
  useEffect(
    () => () => {
      started.current = false;
      setInviteDraft(key, null);
    },
    [key],
  );
}
