import type { AgentSection, AgentTab } from "@agenteschat/client/lib/agent-edit";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { AgentPage } from "@/pages/AgentPage";

/**
 * The agent's page in the panel beside the conversation, over an overlay that dims it; a click there
 * closes the panel (asking first when something is unsaved).
 */
export function AgentPanel({ agentId, tab, onClose }: { agentId: string; tab?: AgentTab; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const name = dir.agentById.get(agentId)?.name ?? "";
  const [place, setPlace] = useState<{ tab: AgentTab; section?: AgentSection }>({ tab: tab ?? "overview" });
  const [closeRequest, setCloseRequest] = useState(0);
  return (
    <>
      <button
        type="button"
        className="thread-panel__scrim"
        tabIndex={-1}
        aria-label={t("common.close")}
        onClick={() => setCloseRequest((n) => n + 1)}
      />
      <aside className="thread-panel thread-panel--wide" aria-label={t("agentPage.panel.label", agentGrammar(name))}>
        <div className="thread-panel__page">
          <AgentPage
            agentId={agentId}
            tab={place.tab}
            section={place.section}
            onNavigate={(tab, section) => setPlace({ tab, section })}
            onClose={onClose}
            closeRequest={closeRequest}
          />
        </div>
      </aside>
    </>
  );
}
