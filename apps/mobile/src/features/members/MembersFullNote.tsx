import { useAuthConfig, useWorkspaceLimits } from "@agenteschat/client";
import { membersFull, membersFullText } from "@agenteschat/client/lib/limits";
import { can } from "@agenteschat/client/lib/permissions";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { GroupedFooter } from "@/ui";

/** No one more fits (ADR 0079): who can make room. Nothing while there is room or no limit. */
export function MembersFullNote() {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const full = membersFull(useWorkspaceLimits(orgId).data);
  const config = useAuthConfig().data;
  const billing = can(org, "manage_billing") && Boolean(config?.billingUrl);
  if (!full) return null;
  const who = t(billing ? "limits.members.fullAdmin" : "limits.members.fullMember");
  return <GroupedFooter>{`${membersFullText(t, full.members, full.limit)} ${who}`}</GroupedFooter>;
}
