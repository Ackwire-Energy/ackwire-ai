import { keys, useApi } from "@agenteschat/client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/ui";
import { chatHref } from "../links/logic";
import { useOrgId } from "../shared/hooks";
import { closeSheetsAndOpen } from "./parts";

/**
 * Opens (or creates) the direct conversation with an agent or a person, closing the sheets on the way.
 * `then` runs first with the conversation's id (a request from "Novo" is posted there); if it fails, the
 * sheets stay open with what was typed.
 */
export function useOpenDm() {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const qc = useQueryClient();
  const toast = useToast();
  return useCallback(
    (target: { agentId: string } | { userId: string }, then?: (channelId: string) => Promise<unknown>) =>
      api.dms
        .open(orgId, target)
        .then(async ({ channelId }) => {
          if (then) await then(channelId);
          void qc.invalidateQueries({ queryKey: keys.dms(orgId) });
          closeSheetsAndOpen(chatHref(channelId));
        })
        .catch(() => toast({ title: t("mobile.app.failed"), icon: "x" })),
    [api, orgId, qc, toast, t],
  );
}
