import type { AgentBrainInput, MachineAccount } from "@agenteschat/client";
import { keys, useAgentBrain, useAiAccounts, useApi } from "@agenteschat/client";
import { ownSignInName, signInPlan } from "@agenteschat/client/lib/ai-accounts";
import { brainLine } from "@agenteschat/client/lib/brain";
import { lowerFirst } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { can } from "@agenteschat/client/lib/permissions";
import { planName, planOf } from "@agenteschat/client/lib/plans";
import { limitOffers, planState } from "@agenteschat/ui/plan-state";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, ProviderLogo, Text, useToast } from "@/ui";
import { useColors, useDirectory, useMeId } from "../shared/hooks";
import { PushedHeader } from "../shared/parts";
import { PlanMeter } from "../usage/parts";
import { accountKindOf, agentAccounts, takenFrom, thinkingUsage } from "./logic";
import { openConnectAi } from "./NoAiCard";
import { Note, PlanReplies, PlanRepliesOf } from "./parts";

/*
 * An agent's AI on the phone (the web's "Quem pensa" for a plan, ADR 0059), from "Pensa com" on its profile: the
 * account it thinks with on its computer (one of its owner's, or that computer's own sign-in), that plan's usage
 * with, at its limit, the owner's other accounts that could think instead, and "Responde a todos". Each choice saves
 * at once. Another AI goes through Connect an AI. Its owner and admins open it; only its owner picks an account or
 * lets other people talk to it on the plan (`canUsePlans`).
 */

/** The plan's page Connect an AI opens on for another account of that kind. */
const PLAN_INTENT = { claude_code: "claude", codex: "chatgpt" } as const;

/** Opens an agent's AI. */
export const openAgentAi = (agentId: string) => router.push(`/agent-ai/${agentId}` as never);

export function AgentAiScreen({ agentId }: { agentId: string }) {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const dir = useDirectory();
  const meId = useMeId();
  const agent = dir.agentById.get(agentId);
  const name = agent?.name ?? "";
  const g = agentGrammar(t, name);
  const ownerFirst = agent?.ownerUserId ? dir.memberById.get(agent.ownerUserId)?.name.split(" ")[0] : undefined;
  // As on the web: its owner and admins load it, members don't.
  const allowed = (meId !== null && agent?.ownerUserId === meId) || can(org?.role, "manage_agents");
  const brain = useAgentBrain(orgId, agentId, allowed);
  const [busy, setBusy] = useState(false);
  // Looking at the plan: its usage is looked up again (it comes back as `machine.updated`).
  useEffect(() => {
    void api.machines.refreshAccountUsage(orgId).catch(() => undefined);
  }, [api, orgId]);

  const view = brain.data;
  const kind = accountKindOf(view?.brain);
  // Its computer's row, where the computer's own sign-in's plan is (a seat has its own words).
  const row = useAiAccounts(orgId, view?.canUsePlans === true && kind !== null).data?.computers.find(
    (c) => c.machineId === view?.computer?.machineId,
  );
  const thinks = brainLine(t, agent?.brain, t("brain.model"));
  const refresh = () => {
    for (const key of [
      keys.agentBrain(orgId, agentId),
      keys.agents(orgId),
      keys.aiAccounts(orgId),
      keys.aiStatus(orgId),
    ])
      void qc.invalidateQueries({ queryKey: key });
  };
  const save = async (input: AgentBrainInput, done: string) => {
    setBusy(true);
    try {
      qc.setQueryData(keys.agentBrain(orgId, agentId), await api.agents.setBrain(orgId, agentId, input));
      toast({ title: done, icon: "check" });
    } catch {
      toast({ title: t("agentPage.work.failed"), icon: "x" });
    } finally {
      refresh();
      setBusy(false);
    }
  };
  const accounts = view && kind ? agentAccounts(view, kind) : [];
  const current = view ? accounts.find((a) => a.id === view.account) : undefined;
  // Another account: Connect an AI on that plan's page (a coding plan's key, on its first page).
  const connect = () =>
    openConnectAi({ agentId, ...(kind && !planOf(current?.provider) ? { intent: PLAN_INTENT[kind] } : {}) });
  const computer = view?.computer?.name ?? "";
  const mayPick = view?.canUsePlans === true && !busy;
  const choose = (a: MachineAccount | null) => {
    if (!view || !mayPick || (a?.id ?? null) === view.account) return;
    // The computer's own sign-in is chosen only where it is its owner's: the account their agents share.
    const done = a
      ? t("agentPage.work.saved.account", { ...g, account: a.label })
      : t("aiAccounts.done.savedAgent", { agent: name, label: lowerFirst(t("connectAi.own.shared"), i18n.language) });
    const others = a ? takenFrom(a, name) : [];
    if (!a || others.length === 0) return void save({ account: a?.id ?? null }, done);
    // One account thinks for one agent: picking another agent's takes it from that one.
    Alert.alert(a.label, t("agentPage.work.brain.accountMove", { agents: others.join(", ") }), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("mobile.ai.moveHere"), onPress: () => void save({ account: a.id, moveAccount: true }, done) },
    ]);
  };
  const replyToEveryone = (on: boolean) => {
    if (busy) return;
    void save({ onlyOwner: !on }, t(on ? "aiAccounts.share.savedEveryone" : "aiAccounts.share.savedOwner", g));
  };

  const usage = view && kind ? thinkingUsage(view, kind) : undefined;
  const limited = usage ? planState(usage).state === "limited" : false;
  const offers = limited && kind && view?.canUsePlans ? limitOffers(accounts, kind, view.account).slice(0, 2) : [];
  const signedOut = current?.status === "signed_out" && current.mine;
  const accountNote = signedOut
    ? t("agentPage.work.brain.accountSignedOut")
    : view && !view.canUsePlans && ownerFirst
      ? t("agentPage.work.brain.accountLocked", { name: ownerFirst })
      : null;

  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={t("mobile.intentAgents.thinks")} solid={false} grouped />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.in, { paddingBottom: insets.bottom + 24 }]}
      >
        <View style={styles.hero}>
          {thinks.mark ? <ProviderLogo id={thinks.mark} size="hero" /> : null}
          <Text variant="title2" tone="ink" style={styles.center}>
            {thinks.text}
          </Text>
        </View>
        {!allowed ? (
          <Note icon="lock">{t("agentPage.lock.admins")}</Note>
        ) : brain.isPending ? (
          <ActivityIndicator color={c.muted} style={styles.loading} />
        ) : !view ? (
          <Note icon="x">{t("common.loadFailed")}</Note>
        ) : (
          <>
            {kind && view.accountsSupported && view.computer ? (
              <>
                <GroupedHeader>{t(`agentPage.work.brain.account.${kind}`)}</GroupedHeader>
                <GroupedList>
                  <GroupedRow
                    leading={<ProviderLogo id={kind} size="sm" />}
                    label={ownSignInName(t, view.ownSignIn && view.canUsePlans, computer)}
                    {...(view.ownSignIn ? {} : { sub: t("aiAccounts.share.hereNotYours", { computer }), subLines: 2 })}
                    checked={view.account === null}
                    // The computer's own sign-in thinks only for agents of whoever connected it (ADR 0059 §3).
                    disabled={!mayPick || (!view.ownSignIn && view.account !== null)}
                    onPress={() => choose(null)}
                  />
                  {accounts.map((a) => {
                    const others = takenFrom(a, name);
                    const about = !a.mine
                      ? t("agentPage.work.brain.accountOf", { name: a.ownerName?.split(" ")[0] ?? "" })
                      : a.status === "signed_out"
                        ? t("agentPage.work.brain.accountSignedOut")
                        : others.length
                          ? t("agentPage.work.brain.accountMove", { agents: others.join(", ") })
                          : a.keyHint
                            ? t("aiAccounts.page.keyEnds", { hint: a.keyHint })
                            : (a.email ?? undefined);
                    return (
                      <GroupedRow
                        key={a.id}
                        leading={<ProviderLogo id={a.provider ?? a.kind} size="sm" off={a.status === "signed_out"} />}
                        label={a.plan ? `${a.label} · ${planName(a.plan)}` : a.label}
                        {...(about ? { sub: about } : {})}
                        checked={a.id === view.account}
                        disabled={!mayPick || !a.mine}
                        onPress={() => choose(a)}
                      />
                    );
                  })}
                  {view.canUsePlans && view.canManageAccounts ? (
                    <GroupedRow
                      icon="plus"
                      label={signedOut ? t("agentPage.work.brain.signInAgain") : t("agentPage.work.brain.addAccount")}
                      onPress={connect}
                    />
                  ) : null}
                </GroupedList>
                {accountNote ? <GroupedFooter>{accountNote}</GroupedFooter> : null}
              </>
            ) : null}
            {usage ? (
              <>
                <GroupedHeader>{t("agentPage.tabs.usage")}</GroupedHeader>
                <GroupedList>
                  <View style={styles.meter}>
                    <PlanMeter usage={usage} />
                  </View>
                  {offers.map(({ account: a, used }) => (
                    <GroupedRow
                      key={a.id}
                      leading={<ProviderLogo id={a.provider ?? a.kind} size="sm" />}
                      label={
                        used === null
                          ? t("aiAccounts.usage.offer.useUnknown", { label: a.label })
                          : t("aiAccounts.usage.offer.use", { label: a.label, pct: used })
                      }
                      disabled={busy}
                      onPress={() => choose(a)}
                    />
                  ))}
                  {limited && view.canUsePlans && view.canManageAccounts ? (
                    <GroupedRow icon="plus" label={t("aiAccounts.usage.offer.connect")} onPress={connect} />
                  ) : null}
                </GroupedList>
              </>
            ) : null}
            {kind && agent?.ownerUserId ? (
              <>
                <GroupedHeader>{t("mobile.ai.audience", g)}</GroupedHeader>
                {view.canUsePlans ? (
                  <PlanReplies
                    on={!view.onlyOwner}
                    onChange={replyToEveryone}
                    brain={kind}
                    plan={signInPlan(view, row, kind)}
                    maker={planOf(current?.provider)?.maker}
                    disabled={busy}
                  />
                ) : (
                  <PlanRepliesOf on={!view.onlyOwner} owner={ownerFirst ?? ""} agentName={name} />
                )}
              </>
            ) : null}
            {view.canUsePlans ? (
              <>
                <GroupedHeader>{t("mobile.ai.another")}</GroupedHeader>
                <GroupedList>
                  <GroupedRow
                    icon="brain"
                    label={t("connectAi.titleFor", g)}
                    chevron
                    onPress={() => openConnectAi({ agentId })}
                  />
                </GroupedList>
              </>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 8 },
  hero: { alignItems: "center", gap: 10, paddingTop: 6, paddingBottom: 4 },
  center: { textAlign: "center" },
  loading: { marginTop: 16 },
  meter: { paddingHorizontal: 14, paddingVertical: 12 },
});
