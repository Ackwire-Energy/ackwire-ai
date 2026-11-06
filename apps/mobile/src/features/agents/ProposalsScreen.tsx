import { useProposals } from "@agenteschat/client";
import { isOpen, proposalWhy, sortProposals } from "@agenteschat/client/lib/proposals";
import { useTranslation } from "react-i18next";
import { RefreshControl, StyleSheet, View } from "react-native";
import { EmptyState, Text } from "@/ui";
import { ChangeRequestRow } from "../right-hand/SettingsCard";
import { LoadFailed } from "../shared/FirstUse";
import { useOrgId, usePullRefresh } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { InstructionProposalCard } from "./InstructionProposalCard";

/** The open proposals, each with why and its card, decided here. What was decided stays on the web's list. */
export function ProposalsScreen() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const proposals = useProposals(orgId);
  const pull = usePullRefresh(proposals.refetch);
  const open = sortProposals((proposals.data ?? []).filter(isOpen));
  return (
    <PushedLargeTitle
      title={t("shell.proposals")}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {proposals.isError && !proposals.data ? <LoadFailed onRetry={() => void proposals.refetch()} /> : null}
      {proposals.isSuccess && open.length === 0 ? (
        <EmptyState size="inline" title={t("proposals.emptyTitle")} subtitle={t("proposals.empty")} />
      ) : null}
      <View style={styles.list}>
        {open.map((p) => (
          <View key={p.id} style={styles.item}>
            <Text variant="subhead" tone="muted">
              {proposalWhy(t, p)}
            </Text>
            {p.target.type === "agent_settings" ? <ChangeRequestRow p={p} /> : <InstructionProposalCard ids={[p.id]} />}
          </View>
        ))}
      </View>
    </PushedLargeTitle>
  );
}

const styles = StyleSheet.create({
  list: { gap: 20, paddingHorizontal: 16 },
  item: { gap: 8 },
});
