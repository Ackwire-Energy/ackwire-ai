import type { MessageConsultation } from "@agenteschat/client";
import { AgentTalkPill } from "@/components/ConsultGroup";

/**
 * What another agent told this one before it answered (`meta.consulted`), or did with work it handed it: the two
 * agents' pill ("Ada ⇄ Atlas · respondeu"), opening their conversation.
 */
export function ConsultationCard({
  consultation: c,
  askerId,
}: {
  consultation: MessageConsultation;
  /** The agent that asked (the reply's author). */
  askerId: string;
}) {
  return <AgentTalkPill consultationId={c.consultationId} fromId={askerId} toId={c.agentId} stored={c} />;
}
