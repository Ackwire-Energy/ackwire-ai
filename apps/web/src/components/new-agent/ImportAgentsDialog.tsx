import { Dialog, DialogBody } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { ImportFlow, useImportFlow } from "@/components/ImportFlow";

/**
 * "Trazer agentes de outro app" over whatever asked for it (the new agent's card, the onboarding's team step): the
 * import runs here, so what was being filled in behind it stays. It stays open while files are read or sent.
 */
export function ImportAgentsDialog({
  orgId,
  standalone = false,
  onClose,
}: {
  orgId: string;
  /** In a workspace already open: the report links to what arrived. */
  standalone?: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const flow = useImportFlow(orgId);
  const running = Boolean(flow.busy) || Boolean(flow.copy?.running);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !running && onClose()}
      title={t("shell.importAgents")}
      closeLabel={t("common.close")}
      width={720}
    >
      <DialogBody>
        <ImportFlow flow={flow} orgId={orgId} standalone={standalone} level={3} />
      </DialogBody>
    </Dialog>
  );
}
