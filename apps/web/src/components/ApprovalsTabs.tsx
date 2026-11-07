import { useOverview } from "@agenteschat/client";
import { Tabs } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useOrg } from "./org-context";

/** Aprovações' two kinds of what waits on you: what agents ask to do now, and what they propose to change. */
export function ApprovalsTabs({ value }: { value: "requests" | "proposals" }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const overview = useOverview(org.id).data;
  return (
    <div className="tabs-bar">
      <Tabs
        value={value}
        onValueChange={(tab) =>
          void navigate({
            to: tab === "proposals" ? "/org/$orgId/proposals" : "/org/$orgId/approvals",
            params: { orgId: org.id },
          })
        }
        label={t("approvals.title")}
        items={[
          {
            value: "requests",
            label: t("approvals.tabs.requests"),
            count: overview?.approvalsWaitingForMe || undefined,
          },
          { value: "proposals", label: t("proposals.title"), count: overview?.proposalsWaitingForMe || undefined },
        ]}
      >
        {null}
      </Tabs>
    </div>
  );
}
