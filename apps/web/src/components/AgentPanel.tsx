import type { AgentSection, AgentTab } from "@agenteschat/client/lib/agent-edit";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Button } from "@agenteschat/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { AgentPage } from "@/pages/AgentPage";

/**
 * The agent's page in the panel beside the conversation, over an overlay that dims it. Its ×, Esc inside it, a click
 * on the overlay and its opener again (`closeRequest`, a new number each time) close it, asking first when something
 * is unsaved. It takes the focus when it opens, so Esc and Tab start there.
 */
export function AgentPanel({
  agentId,
  tab,
  closeRequest: asked,
  onClose,
}: {
  agentId: string;
  tab?: AgentTab;
  closeRequest?: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const name = dir.agentById.get(agentId)?.name ?? "";
  const [place, setPlace] = useState<{ tab: AgentTab; section?: AgentSection }>({ tab: tab ?? "overview" });
  const [closeRequest, setCloseRequest] = useState(0);
  const request = () => setCloseRequest((n) => n + 1);
  useEffect(() => {
    if (asked) setCloseRequest((n) => n + 1);
  }, [asked]);
  const self = useRef<HTMLElement>(null);
  useEffect(() => self.current?.focus({ preventScroll: true }), []);
  return (
    <>
      <button
        type="button"
        className="thread-panel__scrim"
        tabIndex={-1}
        aria-label={t("common.close")}
        onClick={request}
      />
      <aside
        ref={self}
        tabIndex={-1}
        className="thread-panel thread-panel--wide"
        aria-label={t("agentPage.panel.label", agentGrammar(name))}
        onKeyDown={(e) => {
          // A field's Esc and an open dialog's or menu's (which mark it handled) are theirs.
          if (e.key !== "Escape" || e.defaultPrevented || document.querySelector('[role="dialog"]')) return;
          if (e.target instanceof Element && e.target.closest("input, textarea, [contenteditable='true']")) return;
          e.preventDefault();
          request();
        }}
      >
        <Button
          size="sm"
          iconOnly
          icon="close"
          className="agp-glass thread-panel__close"
          aria-label={t("common.close")}
          title={t("common.close")}
          onClick={request}
        />
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
