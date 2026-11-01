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

export type PushLocale = "pt-BR" | "en";

export const PUSH_TITLE_MAX = 80;
export const PUSH_BODY_MAX = 180;

/** `pt`, `pt-BR`, `pt_PT`… → pt-BR; anything else → en. */
export function pushLocale(locale: string | null | undefined): PushLocale {
  return /^pt\b/i.test((locale ?? "").replace("_", "-")) ? "pt-BR" : "en";
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
}

interface Strings {
  someone: string;
  anAgent: string;
  approvalTitle: (actor: string) => string;
  approvalBody: string;
  approvalHighRisk: (what: string) => string;
  approvalFromRoutine: (routine: string) => string;
  questionTitle: (actor: string) => string;
  questionBody: string;
  forumTitle: string;
  forumBody: string;
  mentionTitle: (actor: string) => string;
  replyTitle: (actor: string) => string;
  missionStoppedTitle: string;
  routineFailedTitle: string;
  runFailedTitle: (actor: string) => string;
  routineFailedBody: string;
  routinePausedTitle: string;
  routinePausedBody: string;
  agentUnreachedTitle: (agent: string) => string;
  agentUnreachedBody: string;
  routineStalledTitle: string;
  routineStalledBody: (computer: string) => string;
  routineWaitingPlanTitle: string;
  routineWaitingPlanBody: string;
  planResetUnknownTitle: (plan: string) => string;
  planResetUnknownBody: (agent: string) => string;
  machineConnectedTitle: string;
  computerReadyTitle: string;
  computerReadyBody: string;
  browserHandoffTitle: (actor: string) => string;
  browserHandoffBody: string;
  desktopHandoffTitle: (actor: string) => string;
  desktopHandoffBody: string;
  secretTitle: (actor: string) => string;
  secretBody: string;
  joinRequestTitle: (name: string, org: string) => string;
  joinSuggestionTitle: (by: string, name: string, org: string) => string;
  joinRequestBody: string;
  waitingTitle: string;
  openBody: string;
  sentGif: string;
  sentSticker: string;
}

/** Exported for the test that reads every text as a phone shows it. */
export const PUSH_STRINGS: Record<PushLocale, Strings> = {
  "pt-BR": {
    someone: "Alguém",
    anAgent: "Um agente",
    approvalTitle: (a) => `${a} precisa da sua aprovação`,
    approvalBody: "Toque para ver o pedido.",
    approvalHighRisk: (what) => `${what}. Abra o app para revisar com calma.`,
    approvalFromRoutine: (routine) => `Rotina «${routine}»`,
    questionTitle: (a) => `${a} tem uma pergunta para você`,
    questionBody: "Toque para responder.",
    forumTitle: "Sua vez de opinar",
    forumBody: "Toque para entrar na conversa.",
    mentionTitle: (a) => `${a} mencionou você`,
    replyTitle: (a) => `${a} respondeu`,
    missionStoppedTitle: "Uma missão parou",
    routineFailedTitle: "Uma rotina não terminou",
    runFailedTitle: (a) => `${a} não conseguiu terminar`,
    routineFailedBody: "Toque para ver o que aconteceu.",
    routinePausedTitle: "Uma rotina foi pausada",
    routinePausedBody: "Toque para ver o motivo.",
    agentUnreachedTitle: (agent) => `Uma rotina não conseguiu chamar ${agent}`,
    agentUnreachedBody: "Só quem cuida do agente pode falar com ele. Toque para deixar.",
    routineStalledTitle: "Uma rotina está esperando o computador",
    routineStalledBody: (c) => `Ela roda quando ${c} voltar.`,
    routineWaitingPlanTitle: "Uma rotina está esperando o plano renovar",
    routineWaitingPlanBody: "Ela roda quando ele renovar.",
    planResetUnknownTitle: (p) => `O ${p} não disse quando o limite renova`,
    planResetUnknownBody: (a) => `O trabalho de ${a} segue esperando.`,
    machineConnectedTitle: "Um computador novo entrou no workspace",
    computerReadyTitle: "O computador do seu workspace está pronto",
    computerReadyBody: "Abra a página de um agente para ver ao vivo.",
    browserHandoffTitle: (a) => `${a} precisa de você no navegador`,
    browserHandoffBody: "Toque para abrir a tela.",
    desktopHandoffTitle: (a) => `${a} precisa de você no computador`,
    desktopHandoffBody: "Abra o agentes.chat num notebook para ajudar.",
    secretTitle: (a) => `${a} precisa de um segredo seu`,
    secretBody: "Toque para enviar com segurança.",
    joinRequestTitle: (name, org) => `${name} pede para entrar na ${org}`,
    joinSuggestionTitle: (by, name, org) => `${by} sugeriu ${name} para a ${org}`,
    joinRequestBody: "Toque para aprovar ou recusar.",
    waitingTitle: "Tem algo esperando você",
    openBody: "Toque para abrir.",
    sentGif: "Mandou um GIF",
    sentSticker: "Mandou uma figurinha",
  },
  en: {
    someone: "Someone",
    anAgent: "An agent",
    approvalTitle: (a) => `${a} needs your approval`,
    approvalBody: "Tap to see the request.",
    approvalHighRisk: (what) => `${what}. Open the app to review it.`,
    approvalFromRoutine: (routine) => `Routine «${routine}»`,
    questionTitle: (a) => `${a} has a question for you`,
    questionBody: "Tap to answer.",
    forumTitle: "Your turn to weigh in",
    forumBody: "Tap to join the conversation.",
    mentionTitle: (a) => `${a} mentioned you`,
    replyTitle: (a) => `${a} replied`,
    missionStoppedTitle: "A mission stopped",
    routineFailedTitle: "A routine didn't finish",
    runFailedTitle: (a) => `${a} couldn't finish`,
    routineFailedBody: "Tap to see what happened.",
    routinePausedTitle: "A routine was paused",
    routinePausedBody: "Tap to see why.",
    agentUnreachedTitle: (agent) => `A routine couldn't call ${agent}`,
    agentUnreachedBody: "Only the people the agent works with can talk to it. Tap to let it.",
    routineStalledTitle: "A routine is waiting for its computer",
    routineStalledBody: (c) => `It runs when ${c} is back.`,
    routineWaitingPlanTitle: "A routine is waiting for its plan to reset",
    routineWaitingPlanBody: "It runs when the plan resets.",
    planResetUnknownTitle: (p) => `${p} didn't say when its limit resets`,
    planResetUnknownBody: (a) => `${a}'s work is still waiting.`,
    machineConnectedTitle: "A new computer joined the workspace",
    computerReadyTitle: "Your workspace's computer is ready",
    computerReadyBody: "Open an agent's page to see it live.",
    browserHandoffTitle: (a) => `${a} needs you in the browser`,
    browserHandoffBody: "Tap to open the screen.",
    desktopHandoffTitle: (a) => `${a} needs you on the computer`,
    desktopHandoffBody: "Open agentes.chat on a laptop to help.",
    secretTitle: (a) => `${a} needs a secret from you`,
    secretBody: "Tap to send it securely.",
    joinRequestTitle: (name, org) => `${name} asks to join ${org}`,
    joinSuggestionTitle: (by, name, org) => `${by} suggested ${name} for ${org}`,
    joinRequestBody: "Tap to approve or deny.",
    waitingTitle: "Something is waiting for you",
    openBody: "Tap to open.",
    sentGif: "Sent a GIF",
    sentSticker: "Sent a sticker",
  },
};

const clip = (s: string, max: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

/** Title and body of one push, in the device's language. */
export function renderPush(locale: PushLocale, input: PushTextInput): { title: string; body: string } {
  const s = PUSH_STRINGS[locale];
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
      if (input.screen === "desktop") return out(s.desktopHandoffTitle(actor), text || s.desktopHandoffBody);
      return out(s.browserHandoffTitle(actor), text || s.browserHandoffBody);
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
