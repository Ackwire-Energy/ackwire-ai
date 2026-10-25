import { useEffect, useState } from "react";
import { AgentBrowserNow, useAgentBrowserReady } from "@/components/browser/AgentBrowser";
import { useOpenParam } from "@/lib/open-param";
import { useAgentEdit } from "./context";

/**
 * The agent's browser now, at the top of the overview (on its page and in the panel beside its DM),
 * for whoever may take it over. `?browser=1` (the desktop tray's link, a notification's) opens it.
 */
export function BrowserNow() {
  const { agent } = useAgentEdit();
  const settings = useAgentBrowserReady(agent);
  const [asked, clearAsked] = useOpenParam("browser");
  const [viewing, setViewing] = useState(false);
  useEffect(() => {
    if (asked === null) return;
    setViewing(true);
    clearAsked(null);
  }, [asked, clearAsked]);
  if (!settings) return null;
  return <AgentBrowserNow agent={agent} settings={settings} viewing={viewing} onView={setViewing} />;
}
