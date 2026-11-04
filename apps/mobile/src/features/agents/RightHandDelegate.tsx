import type { CardDelegate } from "@agenteschat/client";
import { useUndoRightHand } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { Button } from "@/ui";
import { useFailed } from "../routines/hooks";
import { useMeId } from "../shared/hooks";

/** Desfazer on what the right hand approved (ADR 0139 §2), while it lasts: for the person it decided for, and admins. */
export function DelegateUndo({ d }: { d: CardDelegate | null | undefined }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const meId = useMeId();
  const failed = useFailed();
  const undo = useUndoRightHand(orgId);
  const id = d?.decisionId;
  const open =
    d?.state === "approved" &&
    id &&
    d.undoUntil &&
    Date.parse(d.undoUntil) > Date.now() &&
    (d.forUserId === meId || can(org, "manage_agents"));
  if (!open) return null;
  return (
    <Button
      variant="secondary"
      size="sm"
      label={t("rightHandApprovals.card.undo")}
      loading={undo.isPending}
      onPress={() => undo.mutate(id, { onError: failed })}
    />
  );
}
