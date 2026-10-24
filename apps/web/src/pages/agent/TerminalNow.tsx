import { useDesktopStatus } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Button, Icon } from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { TerminalView } from "@/components/desktop/TerminalView";
import { useOrg } from "@/components/org-context";
import { useOpenParam } from "@/lib/open-param";
import { useAgentEdit } from "./context";

/**
 * A terminal on the agent's computer (ADR 0058 §6), on its overview under its desktop, only for whoever may run
 * commands there as the agent (the desktop's `terminal.allowed`): a line with "Abrir o terminal" once the computer
 * serves one. `?terminal=1` opens it (and says why when it can't).
 */
export function TerminalNow() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent } = useAgentEdit();
  const status = useDesktopStatus(org.id, agent.id);
  const [asked, clearAsked] = useOpenParam("terminal");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (asked === null) return;
    setOpen(true);
    clearAsked(null);
  }, [asked, clearAsked]);
  const terminal = status.data?.terminal;
  if (!terminal?.allowed || !(terminal.available || open)) return null;
  const g = agentGrammar(t, agent.name);
  return (
    <section className="brw-now" aria-label={t("terminal.title", g)}>
      {open ? (
        <TerminalView agentId={agent.id} name={agent.name} onClose={() => setOpen(false)} />
      ) : (
        <div className="brw-now__row">
          <span className="brw-now__ic">
            <Icon name="computerLinux" size={16} />
          </span>
          <span className="brw-now__t">
            <b>{t("terminal.title", g)}</b>
            <span>{t("terminal.now", g)}</span>
          </span>
          <Button size="sm" icon="computerLinux" onClick={() => setOpen(true)}>
            {t("terminal.open")}
          </Button>
        </div>
      )}
    </section>
  );
}
