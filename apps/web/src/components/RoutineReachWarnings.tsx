import { type Agent, type RoutineAccess, useUpdateAgent } from "@agenteschat/client";
import { audienceOf, canEditAudience } from "@agenteschat/client/lib/audience";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { routineReachWarnings } from "@agenteschat/client/lib/reach";
import { Icon } from "@agenteschat/ui";
import { Trans, useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import "./agent-actions.css";

/**
 * In the routine dialog, the agents its prompt names that it won't be able to call, and why (a warning, never a
 * block: its own work still runs). Who may change who talks to the agent lets themselves in, in one click.
 */
export function RoutineReachWarnings({
  prompt,
  access,
  agentId,
}: {
  prompt: string;
  access: RoutineAccess;
  agentId: string | null;
}) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const warnings = routineReachWarnings(prompt, dir.agents, { access, agentId });
  if (warnings.length === 0) return null;
  return (
    <div className="ag-rcs ag-rcs--stack" role="status">
      {warnings.map((w) => (
        <Warning key={w.agent.id} agent={w.agent} kind={w.kind} />
      ))}
    </div>
  );
}

function Warning({ agent, kind }: { agent: Agent; kind: "blocked" | "read" }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const update = useUpdateAgent(org.id, agent.id);
  const g = agentGrammar(t, agent.name);
  const mayAllow = kind === "blocked" && canEditAudience(org, agent, me.user.id);
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
      {mayAllow && (
        <button
          type="button"
          className="ag-rc__btn"
          disabled={update.isPending || update.isSuccess}
          onClick={() => {
            const a = audienceOf(agent);
            const userIds = [...new Set([...(a.mode === "people" ? a.userIds : []), me.user.id])];
            update.mutate({ audience: { mode: "people", userIds } });
          }}
        >
          {t("routines.reachWarning.allow", { person: me.user.name, pronoun: g.pronoun })}
        </button>
      )}
    </div>
  );
}
