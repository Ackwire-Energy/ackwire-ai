import type { ConsultationStatus, MessageConsultation } from "../api/types";

/** How long an agent waits for another one's answer (the server's `CONSULTATION_TTL_MS`). */
export const CONSULTATION_MINUTES = 15;

const STATUSES: ReadonlySet<string> = new Set<ConsultationStatus>(["answered", "expired", "failed"]);

/** `meta.consulted` of an agent's reply: the agents it asked before answering (bad entries left out). */
export function consultationsOf(meta: Record<string, unknown> | undefined): MessageConsultation[] {
  const list = meta?.consulted;
  if (!Array.isArray(list)) return [];
  return list.flatMap((v): MessageConsultation[] => {
    if (!v || typeof v !== "object") return [];
    const o = v as Record<string, unknown>;
    if (typeof o.agentId !== "string" || !o.agentId) return [];
    const status = typeof o.status === "string" && STATUSES.has(o.status) ? (o.status as ConsultationStatus) : "failed";
    const answer = status === "answered" && typeof o.answer === "string" && o.answer.trim() ? o.answer : null;
    return [
      {
        agentId: o.agentId,
        consultationId: typeof o.consultationId === "string" ? o.consultationId : `${o.agentId}:${status}`,
        // Answered with nothing to show is told as "couldn't answer".
        status: status === "answered" && !answer ? "failed" : status,
        question: typeof o.question === "string" ? o.question : "",
        answer,
      },
    ];
  });
}

/** One line of an answer for the folded card: no Markdown marks, spaces collapsed. */
export function previewOf(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>~|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
