import { useAiStatus } from "@agenteschat/client";
import { aiStateOf } from "@agenteschat/client/lib/no-ai";
import { useEffect, useState } from "react";
import { useConnectAi, useMayConnectAi } from "@/components/ConnectAi";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { ARRIVAL_PARAM } from "@/lib/arrival";
import { useOpenParam } from "@/lib/open-param";
import { BetaDialog } from "./BetaDialog";

/**
 * Right after the onboarding (ADR 0160): the beta notice, then Connect an AI with the team on its stage, for a
 * person who has an AI to connect while some agent has none. Asked for by the address, once: the mark is dropped as
 * it opens, so a reload or Back shows neither again.
 */
export function Arrival() {
  const { org } = useOrg();
  const [asked, clear] = useOpenParam(ARRIVAL_PARAM);
  const [beta, setBeta] = useState(false);
  const connect = useConnectAi();
  const mayConnect = useMayConnectAi();
  const dir = useDirectory(org.id);
  const status = useAiStatus(org.id);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per link
  useEffect(() => {
    if (asked === null) return;
    setBeta(true);
    clear(null);
  }, [asked]);
  if (!beta) return null;
  // Every agent already thinks (a workspace joined with its AI in place): nothing to connect.
  const allThink =
    dir.agents.length > 0 && dir.agents.every((a) => (aiStateOf(status.data, a.id) ?? "no_ai") !== "no_ai");
  return (
    <BetaDialog
      onContinue={() => {
        setBeta(false);
        if (mayConnect && !allThink) connect?.open({ arrival: true });
      }}
    />
  );
}
