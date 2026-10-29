import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { sharePlanBody } from "@agenteschat/client/lib/plans";
import { Button, Dialog, DialogFooter } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";

/**
 * "Agora a Ada responde a todos" (ADR 0059 §5): before an agent answers other
 * people on its owner's personal plan, the provider's own words about
 * personal use. Going on is a deliberate choice; keeping it is the easy one.
 */
export function SharePlanDialog({
  agentName,
  brain,
  plan,
  maker,
  everyone,
  onAccept,
  onKeep,
}: {
  agentName: string;
  brain: "claude_code" | "codex";
  /** The account's plan as the CLI says it (`max`, `team`…). */
  plan?: string | null;
  /** A coding plan's maker (a key account): its own wording. */
  maker?: string;
  /** Everyone, or only some more people. */
  everyone: boolean;
  onAccept: () => void;
  onKeep: () => void;
}) {
  const { t } = useTranslation();
  const g = agentGrammar(t, agentName);
  const body = sharePlanBody(t, brain, plan, maker);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onKeep()}
      title={t(everyone ? "aiAccounts.share.title" : "aiAccounts.share.titlePeople", g)}
      description={body}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogFooter>
        <Button variant="ghost" onClick={onKeep}>
          {t("aiAccounts.share.keep", g)}
        </Button>
        <Button variant="primary" onClick={onAccept}>
          {t(everyone ? "aiAccounts.share.accept" : "aiAccounts.share.acceptPeople")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
