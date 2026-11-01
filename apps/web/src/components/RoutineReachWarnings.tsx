import type { Agent, RoutineAccess } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { routineReachWarnings } from "@agenteschat/client/lib/reach";
import { Icon } from "@agenteschat/ui";
import { Trans, useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { AllowTalkButton } from "@/components/ReachLines";
import { useDirectory } from "@/hooks/useDirectory";
import "./agent-actions.css";

/**
 * In the routine dialog, the agents its prompt names that it won't be able to call, and why (a warning, never a
 * block: its own work still runs). Its creator's reach counts (`creatorUserId` when editing; the viewer when new), and
 * who may change who talks to the agent lets the creator in, in one click.
 */
export function RoutineReachWarnings({
  prompt,
  access,
  agentId,
  creatorUserId,
}: {
  prompt: string;
  access: RoutineAccess;
  agentId: string | null;
  creatorUserId?: string | null;
}) {
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const creator = creatorUserId ?? me.user.id;
  const warnings = routineReachWarnings(prompt, dir.agents, {
    access,
    agentId,
    creatorUserId: creator === me.user.id ? null : creator,
  });
  if (warnings.length === 0) return null;
  return (
    <div className="ag-rcs ag-rcs--stack" role="status">
      {warnings.map((w) => (
        <Warning key={w.agent.id} agent={w.agent} kind={w.kind} creator={creator} />
      ))}
    </div>
  );
}

function Warning({ agent, kind, creator }: { agent: Agent; kind: "blocked" | "read"; creator: string }) {
  const { t } = useTranslation();
  const g = agentGrammar(t, agent.name);
  return (
    <div className="ag-rc">
      <span className="ag-rc__ic" aria-hidden="true">
        <Icon name="info" size={14} />
      </span>
      <span className="ag-rc__tx">
        <span className="ag-rc__sentence">
          <Trans
            i18nKey={kind === "read" ? "routines.reachWarning.read" : "routines.reachWarning.blocked"}
            values={g}
            components={{ b: <b /> }}
          />
        </span>
      </span>
      {kind === "blocked" && <AllowTalkButton agent={agent} userId={creator} className="ag-rc__btn" />}
    </div>
  );
}
