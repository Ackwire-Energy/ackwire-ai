import type { AgentBrain, AgentBrainInput } from "@agenteschat/client";
import { keys, useAgentBrain, useAiAccounts, useAiStatus, useApi, useModels } from "@agenteschat/client";
import { signInPlan } from "@agenteschat/client/lib/ai-accounts";
import {
  type Advanced,
  advancedDefaults,
  advancedSummary,
  EFFORT_LEVELS,
  effortLevel,
  isAdvancedDefault,
} from "@agenteschat/client/lib/brain-advanced";
import { type ContextLimit, contextChoices, contextSize, isContextLimit } from "@agenteschat/client/lib/context-limits";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { planOf } from "@agenteschat/client/lib/plans";
import { isAuto } from "@agenteschat/client/lib/providers";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, useToast } from "@/ui";
import { useColors, useDirectory } from "../shared/hooks";
import { PushedHeader } from "../shared/parts";
import { accountKindOf, agentAccounts } from "./logic";
import { Note, PlanReplies, PlanRepliesOf } from "./parts";

/*
 * An agent's "Configuração avançada" on the phone (ADR 0086), the web's dialog over "Quem pensa" as a screen of its
 * own, opened from "Pensa com" by its owner or an admin: how it thinks (effort, with a fixed model on its computer;
 * the context window, any brain) and who it answers ("Atende outras pessoas", answering through the API while its
 * computer is away). Each choice saves at once, like the rest of "Pensa com"; "Voltar ao padrão" puts them all back.
 */

/** Opens an agent's advanced settings. */
export const openAgentAdvanced = (agentId: string) => router.push(`/agent-advanced/${agentId}` as never);

/** What the agent's view says for the advanced settings (a limit past its model's window reads as none). */
export const advancedOf = (view: AgentBrain, options?: readonly ContextLimit[]): Advanced => {
  const tokens = isContextLimit(view.contextTokens) ? view.contextTokens : null;
  return {
    effort: effortLevel(view.effort),
    contextTokens: tokens !== null && (!options || options.includes(tokens)) ? tokens : null,
    onlyOwner: view.onlyOwner,
    fallback: view.fallback,
  };
};

export function AgentAdvancedScreen({ agentId }: { agentId: string }) {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const dir = useDirectory();
  const agent = dir.agentById.get(agentId);
  const name = agent?.name ?? "";
  const ownerFirst = agent?.ownerUserId ? dir.memberById.get(agent.ownerUserId)?.name.split(" ")[0] : undefined;
  const g = agentGrammar(t, name);
  const brain = useAgentBrain(orgId, agentId);
  const models = useModels();
  const apiKey = useAiStatus(orgId).data?.apiKey !== false;
  const [busy, setBusy] = useState(false);
  const view = brain.data;
  const kind = accountKindOf(view?.brain);
  // Its computer's row, where the computer's own sign-in's plan is (a seat has its own words).
  const row = useAiAccounts(orgId, view?.canUsePlans === true && kind !== null).data?.computers.find(
    (r) => r.machineId === view?.computer?.machineId,
  );
  const current = view && kind ? agentAccounts(view, kind).find((a) => a.id === view.account) : undefined;
  const autoModel = view?.brain === "model" ? isAuto(agent?.model) : isAuto(view?.effectiveModel);
  // The sizes under the window of the model it thinks with ("Automático": any of its line).
  const options = !view
    ? []
    : view.brain === "model"
      ? contextChoices(autoModel ? undefined : models.data?.models.find((m) => m.id === agent?.model))
      : contextChoices(
          autoModel
            ? undefined
            : view.options.find((o) => o.kind === view.brain)?.models.find((m) => m.value === view.effectiveModel),
        );
  const now = view ? advancedOf(view, options) : null;
  const may = !busy && view?.canEdit === true;

  /** Saves at once and says what the row on "Pensa com" will say now (or `done`). */
  const save = async (input: AgentBrainInput, done?: string) => {
    setBusy(true);
    try {
      const next = await api.agents.setBrain(orgId, agentId, input);
      qc.setQueryData(keys.agentBrain(orgId, agentId), next);
      const line = advancedSummary(t, i18n.language, {
        kind: next.brain,
        autoModel,
        apiKey,
        now: advancedOf(next, options),
      });
      toast({ title: done ?? line, icon: "check" });
    } catch {
      toast({ title: t("agentPage.work.failed"), icon: "x" });
    } finally {
      for (const key of [keys.agentBrain(orgId, agentId), keys.agents(orgId)])
        void qc.invalidateQueries({ queryKey: key });
      setBusy(false);
    }
  };
  const putBack = () => {
    if (!view || !now) return;
    const to = advancedDefaults(view.brain, now);
    void save({
      contextTokens: to.contextTokens,
      ...(view.brain === "model"
        ? {}
        : {
            ...(autoModel ? {} : { effort: to.effort }),
            ...(to.onlyOwner !== view.onlyOwner ? { onlyOwner: to.onlyOwner } : {}),
            fallback: to.fallback,
          }),
    });
  };

  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={t("agentPage.work.brain.advanced.title")} solid={false} grouped />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.in, { paddingBottom: insets.bottom + 24 }]}
      >
        {brain.isPending ? (
          <ActivityIndicator color={c.muted} style={styles.loading} />
        ) : !view || !now ? (
          <Note icon="x">{t("common.loadFailed")}</Note>
        ) : (
          <>
            {kind && !autoModel ? (
              <>
                <GroupedHeader>{t("agentPage.work.brain.effort")}</GroupedHeader>
                <GroupedList>
                  {EFFORT_LEVELS.map((e) => (
                    <GroupedRow
                      key={e}
                      label={t(`agentPage.work.brain.efforts.${e}`)}
                      sub={t(`agentPage.work.brain.effortText.${e}`)}
                      subLines={2}
                      checked={now.effort === e}
                      disabled={!may}
                      onPress={() => e !== now.effort && void save({ effort: e })}
                    />
                  ))}
                </GroupedList>
              </>
            ) : null}
            <GroupedHeader>{t("agentPage.work.brain.context")}</GroupedHeader>
            <GroupedList>
              <GroupedRow
                label={t("brain.auto.label")}
                sub={t("agentPage.work.brain.contextText.auto")}
                checked={now.contextTokens === null}
                disabled={!may}
                onPress={() => now.contextTokens !== null && void save({ contextTokens: null })}
              />
              {options.map((n) => (
                <GroupedRow
                  key={n}
                  label={contextSize(n)}
                  sub={t(`agentPage.work.brain.contextText.${n}`)}
                  subLines={2}
                  checked={now.contextTokens === n}
                  disabled={!may}
                  onPress={() => n !== now.contextTokens && void save({ contextTokens: n })}
                />
              ))}
            </GroupedList>
            {kind ? (
              <>
                <GroupedHeader>{t("agentPage.work.brain.advanced.answers")}</GroupedHeader>
                {agent?.ownerUserId ? (
                  view.canUsePlans ? (
                    <PlanReplies
                      agent={name}
                      on={!view.onlyOwner}
                      onChange={(on) => {
                        if (busy) return;
                        void save(
                          { onlyOwner: !on },
                          t(on ? "aiAccounts.share.savedEveryone" : "aiAccounts.share.savedOwner", g),
                        );
                      }}
                      brain={kind}
                      plan={signInPlan(view, row, kind)}
                      coding={planOf(current?.provider)}
                      disabled={busy}
                    />
                  ) : (
                    <PlanRepliesOf on={!view.onlyOwner} owner={ownerFirst ?? ""} agentName={name} />
                  )
                ) : null}
                {apiKey ? (
                  <View style={styles.gap}>
                    <GroupedList>
                      <GroupedRow
                        label={t("agentPage.work.brain.fallbackTitle", { computer: view.computer?.name ?? "" })}
                        labelLines={2}
                        toggle={view.fallback}
                        disabled={!may}
                        onPress={() => void save({ fallback: !view.fallback })}
                      />
                    </GroupedList>
                    <GroupedFooter>{t("agentPage.work.brain.fallbackHint", g)}</GroupedFooter>
                  </View>
                ) : null}
              </>
            ) : null}
            <View style={styles.gap}>
              <GroupedList>
                <GroupedRow
                  label={t("agentPage.work.brain.advanced.defaults")}
                  disabled={!may || isAdvancedDefault(view.brain, now)}
                  onPress={putBack}
                />
              </GroupedList>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 8 },
  loading: { marginTop: 16 },
  // A list without a header keeps a header's room above it.
  gap: { marginTop: 18 },
});
