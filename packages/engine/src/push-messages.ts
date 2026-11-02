/**
 * Push notification text (ADR 0035). The one documented exception to "server
 * strings in English": the phone shows it as is, so it is written in the
 * device's language (pt-BR or en, from the locale the app registered).
 *
 * Short and friendly. Never internal names (the router's or the judge's
 * model, vendors, tools): only the agent's or the person's own name and what
 * they wrote. A high-risk approval only says to open the app: it is never
 * approved from the notification.
 */

import { type AppLocale, appLocale } from "@agenteschat/i18n/locale";
import { pushStrings } from "./push/messages";

export type PushLocale = AppLocale;
export { pushStrings };

export const PUSH_TITLE_MAX = 80;
export const PUSH_BODY_MAX = 180;

/** The first language of the app among these tags (`pt_PT` → pt-BR, `ja-JP` → ja), else English. */
export function pushLocale(...tags: (string | null | undefined)[]): PushLocale {
  return appLocale(tags, true) ?? "en";
}

export interface PushTextInput {
  /** Notification kind. */
  kind: string;
  /** In "Esperando você". */
  waiting: boolean;
  /** Who did it: the agent's or the person's name. */
  actorName?: string | null;
  actorType?: "user" | "agent" | null;
  /** Channel, thread, topic, mission or routine name. */
  label?: string | null;
  /** Title of the thing (approval, mission, routine, topic). */
  title?: string | null;
  /** `join_request` from a member's suggestion (ADR 0090): who suggested. */
  suggestedBy?: string | null;
  /** Snippet of what was said. */
  text?: string | null;
  /** A GIF or a sticker sent with no words (ADR 0091): the push says so in place of the snippet. */
  media?: "gif" | "sticker" | null;
  /** An approval of a production, irreversible or external action. */
  highRisk?: boolean;
  /** The routine that asked for an approval while nobody watched (ADR 0053 §8): the push says so. */
  routine?: string | null;
  /** `browser_handoff`: the agent's screen it is on, when not its browser. */
  screen?: string | null;
  /** `browser_handoff` still unanswered an hour later: the title says the agent still needs them. */
  reminder?: boolean;
}

const clip = (s: string, max: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

/** Title and body of one push, in the device's language. */
export function renderPush(locale: PushLocale, input: PushTextInput): { title: string; body: string } {
  const s = pushStrings(locale);
  const actor = input.actorName?.trim() || (input.actorType === "agent" ? s.anAgent : s.someone);
  // A GIF or a sticker alone (ADR 0091) says what it was where its words would go.
  const sent = input.media === "gif" ? s.sentGif : input.media === "sticker" ? s.sentSticker : "";
  const text = input.text?.trim() || sent;
  const what = input.title?.trim() || input.label?.trim() || "";
  const out = (title: string, body: string) => ({
    title: clip(title, PUSH_TITLE_MAX),
    body: clip(body, PUSH_BODY_MAX),
  });
  switch (input.kind) {
    case "approval": {
      // Asked by a routine while nobody watched: its name leads, so the person knows where it comes from.
      const routine = input.routine?.trim();
      const from = (body: string) => (routine ? `${s.approvalFromRoutine(routine)}: ${body}` : body);
      if (input.highRisk)
        return out(s.approvalTitle(actor), from(s.approvalHighRisk(clip(what || s.approvalBody, 120))));
      return out(s.approvalTitle(actor), from(what || s.approvalBody));
    }
    case "agent_question":
      return out(s.questionTitle(actor), text || s.questionBody);
    case "forum_turn":
      return out(s.forumTitle, what || s.forumBody);
    case "mention":
      return out(s.mentionTitle(actor), text || s.openBody);
    case "dm":
      return out(actor, text || s.openBody);
    case "agent_reply":
      // What it answered, from its first words: the person asked and closed the tab.
      return out(s.replyTitle(actor), text || s.openBody);
    case "mission_stopped":
      // Only its name: the reason it stopped may carry technical details.
      return out(s.missionStoppedTitle, what || s.openBody);
    case "routine_failed":
      return out(s.routineFailedTitle, what || s.routineFailedBody);
    case "run_failed":
      return out(s.runFailedTitle(actor), s.routineFailedBody);
    case "routine_paused":
      // Its name only: the app says why, in the person's words.
      return out(s.routinePausedTitle, what || s.routinePausedBody);
    case "agent_unreached":
      return out(s.agentUnreachedTitle(actor), what || s.agentUnreachedBody);
    case "routine_stalled":
      // The computer's name (what the person calls it), else the routine's.
      return out(s.routineStalledTitle, text ? s.routineStalledBody(text) : what || s.openBody);
    case "routine_waiting_plan":
      // The routine's name, then when it runs (the push has no time zone to say the hour in).
      return out(s.routineWaitingPlanTitle, [what, s.routineWaitingPlanBody].filter(Boolean).join(" · "));
    case "plan_reset_unknown":
      // `title`: the plan's name; `label`: the agent's.
      return out(
        s.planResetUnknownTitle(input.title?.trim() || "AI"),
        s.planResetUnknownBody(input.label?.trim() || actor),
      );
    case "machine_connected":
      // Its name and who connected it: if nobody here expected it, it can be removed at once.
      return out(s.machineConnectedTitle, [what, input.actorName?.trim()].filter(Boolean).join(" · ") || s.openBody);
    case "computer_ready":
      return out(s.computerReadyTitle, s.computerReadyBody);
    case "browser_handoff":
      // What the agent asked for, in its words ("Entrar no Stripe com a conta de teste"). A desktop doesn't
      // open on the phone: its body says where it does.
      if (input.screen === "desktop")
        return out(
          (input.reminder ? s.desktopHandoffReminderTitle : s.desktopHandoffTitle)(actor),
          text || s.desktopHandoffBody,
        );
      return out(
        (input.reminder ? s.browserHandoffReminderTitle : s.browserHandoffTitle)(actor),
        text || s.browserHandoffBody,
      );
    case "secret_request":
      // What it is for, in the agent's words: the value is typed in the app, sealed there, never here.
      return out(s.secretTitle(actor), text || what || s.secretBody);
    case "join_request": {
      // The name the person typed, never their note: approving happens in the app, never from the notification.
      const who = input.title?.trim() || s.someone;
      const by = input.suggestedBy?.trim();
      if (by) return out(s.joinSuggestionTitle(by, who, input.label?.trim() || ""), s.joinRequestBody);
      return out(s.joinRequestTitle(who, input.label?.trim() || ""), s.joinRequestBody);
    }
    default:
      return out(input.waiting ? s.waitingTitle : actor, text || what || s.openBody);
  }
}
