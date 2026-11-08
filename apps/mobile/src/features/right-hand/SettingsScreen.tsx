import {
  type Agent,
  type AgentBrainInput,
  keys,
  useAgentBrain,
  useApi,
  useModelLabel,
  usePlatformKey,
  useRoles,
  useSetTeamWeekPrefs,
  useTeamWeekPrefs,
  useUpdateAgent,
} from "@agenteschat/client";
import { agentsReach, audienceOf, audiencePatch } from "@agenteschat/client/lib/audience";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { can } from "@agenteschat/client/lib/permissions";
import { AUTO } from "@agenteschat/client/lib/providers";
import { rightHandFallback, rightHandOf } from "@agenteschat/client/lib/right-hand";
import { dayText, hourText, teamWeekOn } from "@agenteschat/client/lib/team-week";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, TextInput, View } from "react-native";
import { useOrg } from "@/providers/org";
import {
  EmptyState,
  fieldText,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  PressScale,
  ProviderLogo,
  Text,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { openAgentEdit } from "../agents/AgentEditScreen";
import { openAgentAi } from "../ai/AgentAiScreen";
import { openConnectAi } from "../ai/NoAiCard";
import { PlanHoldNote, usePlanHold } from "../ai/parts";
import { useFailed } from "../routines/hooks";
import { Gap, SettingsPage } from "../settings/parts";
import { AgentFace } from "../shared/Face";
import { type Directory, useColors, useDirectory, useMeId } from "../shared/hooks";

/** Opens Configurações › the right hand (ADR 0137). */
export const openRightHandSettings = () => router.push("/settings/right-hand" as never);

/**
 * Configurações › Lodi (ADR 0137), as on the web: only what admins set for the team's right hand. Its name and look,
 * its AI and model or the plan it thinks with ("Atende outras pessoas" under it), its own monthly budget and who may use
 * it (everyone, or the roles picked); one line says it can't be archived or deleted, and its audit log is a tap away.
 * Its instructions are the product's.
 */
export function RightHandSettingsScreen() {
  const { t } = useTranslation();
  const agent = rightHandOf(useDirectory().agents);
  if (!agent)
    return (
      <SettingsPage title={t("settings.section.right_hand")}>
        <EmptyState icon="agent" title={t("mobile.agentEdit.missing")} />
      </SettingsPage>
    );
  return <Form agent={agent} />;
}

/**
 * "Sua IA" (ADR 0137 §11): the plan the person's own DM with the right hand thinks with, theirs or one shared with them,
 * and, without one, what the workspace's does for them. Everyone has it: here and on its profile.
 */
export function RightHandMine({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const failed = useFailed();
  const dir = useDirectory();
  const meId = useMeId();
  const view = useAgentBrain(orgId, agent.id).data;
  const g = agentGrammar(agent.name);
  const kind = view && view.brain !== "model" ? view.brain : null;
  const signIn = view?.accounts.find((a) => a.id === view.account);
  const first = (id: string) => dir.memberById.get(id)?.name.split(" ")[0];
  const platform = usePlatformKey(orgId).data === true;
  const fallback = view?.workspaceAi
    ? rightHandFallback(t, view.workspaceAi, meId ?? undefined, g, first, platform)
    : "";
  const shared = signIn?.ownerId && signIn.ownerId !== meId ? first(signIn.ownerId) : undefined;
  const back = () =>
    void api.agents
      .setBrain(orgId, agent.id, { scope: "mine", brain: "model" })
      .then(() => {
        void qc.invalidateQueries({ queryKey: keys.agentBrain(orgId, agent.id) });
        void qc.invalidateQueries({ queryKey: keys.aiStatus(orgId) });
      })
      .catch(failed);
  return (
    <>
      <GroupedList>
        <GroupedRow
          {...(kind ? { leading: <ProviderLogo id={kind} size="sm" /> } : { icon: "bolt" as const })}
          label={kind ? (signIn?.label ?? t(`aiAccounts.connect.${kind}`)) : t("rightHand.settings.connectMine")}
          {...(shared ? { sub: t("rightHand.settings.planOwner", { owner: shared }) } : {})}
          {...(kind ? { value: t("rightHand.settings.change") } : {})}
          chevron
          onPress={() => openConnectAi({ agentId: agent.id })}
        />
        {kind ? <GroupedRow icon="members" label={t("rightHand.settings.useWorkspace")} onPress={back} /> : null}
      </GroupedList>
      <GroupedFooter>
        {kind
          ? t("rightHand.settings.mineHelp", g)
          : t("common.joinSentences", { a: t("rightHand.settings.mineHelp", g), b: fallback })}
      </GroupedFooter>
    </>
  );
}

/**
 * The workspace's AI on a plan (ADR 0137 §11): what every DM thinks with while its person has none. The plan's account,
 * and "Atende outras pessoas" as for any agent on its owner's plan (the plan's owner chooses, an admin may override,
 * the plan's owner hears it by email): on, whoever has no plan of their own talks to it on this one.
 */
function PlanRows({
  agent,
  kind,
  dir,
}: {
  agent: Agent;
  kind: Exclude<NonNullable<Agent["brain"]>["kind"], "model">;
  dir: Directory;
}) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const held = usePlanHold(orgId, org) !== null;
  const api = useApi();
  const qc = useQueryClient();
  const failed = useFailed();
  const meId = useMeId();
  const view = useAgentBrain(orgId, agent.id, true, false, "workspace").data;
  const signIn = view?.accounts.find((a) => a.id === view.account);
  const owner = signIn?.ownerId ? dir.memberById.get(signIn.ownerId)?.name.split(" ")[0] : undefined;
  const set = (input: AgentBrainInput) =>
    void api.agents
      .setBrain(orgId, agent.id, { scope: "workspace", ...input })
      .then(() => {
        for (const key of [keys.agentBrain(orgId, agent.id), keys.agents(orgId), keys.aiStatus(orgId)])
          void qc.invalidateQueries({ queryKey: key });
      })
      .catch(failed);
  const on = view ? !view.onlyOwner : false;
  const g = agentGrammar(agent.name);
  return (
    <>
      <GroupedList>
        <GroupedRow
          leading={<ProviderLogo id={kind} size="sm" />}
          label={signIn?.label ?? t(`aiAccounts.connect.${kind}`)}
          {...(owner && signIn?.ownerId !== meId ? { sub: t("rightHand.settings.planOwner", { owner }) } : {})}
        />
        {held ? null : (
          <GroupedRow icon="brain" label={t("noAi.rightHand.useKey")} onPress={() => set({ brain: "model" })} />
        )}
      </GroupedList>
      <GroupedFooter>{t("rightHand.settings.planHelp")}</GroupedFooter>
      {view ? (
        <>
          <GroupedList>
            <GroupedRow
              icon="members"
              label={t("aiAccounts.share.switch")}
              toggle={on}
              disabled={!view.canEdit}
              onPress={() => set({ onlyOwner: on })}
            />
          </GroupedList>
          <GroupedFooter>
            {t(
              on
                ? "rightHand.settings.sharesOn"
                : signIn?.ownerId === meId
                  ? "rightHand.settings.sharesOffYou"
                  : "rightHand.settings.sharesOff",
              { ...g, owner: owner ?? "" },
            )}
          </GroupedFooter>
        </>
      ) : null}
    </>
  );
}

/** The plans the workspace's AI may move onto (the admin's own, everyone's with `use_others_plans`), a tap each. */
function WorkspacePlanRows({ agent, dir }: { agent: Agent; dir: Directory }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const hold = usePlanHold(orgId, org);
  const api = useApi();
  const qc = useQueryClient();
  const failed = useFailed();
  const meId = useMeId();
  const view = useAgentBrain(orgId, agent.id, true, false, "workspace").data;
  const g = agentGrammar(agent.name);
  const plans = (view?.accounts ?? []).filter((a) => a.status === "active");
  const pick = (a: (typeof plans)[number]) =>
    void api.agents
      .setBrain(orgId, agent.id, { scope: "workspace", brain: a.kind, account: a.id })
      .then(() => {
        for (const key of [keys.agentBrain(orgId, agent.id), keys.agents(orgId), keys.aiStatus(orgId)])
          void qc.invalidateQueries({ queryKey: key });
      })
      .catch(failed);
  if (hold) return <PlanHoldNote org={org} />;
  return (
    <>
      {plans.length > 0 ? (
        <GroupedList>
          {plans.map((a) => {
            const owner =
              a.ownerId && a.ownerId !== meId ? dir.memberById.get(a.ownerId)?.name.split(" ")[0] : undefined;
            return (
              <GroupedRow
                key={a.id}
                leading={<ProviderLogo id={a.kind} size="sm" />}
                label={a.label}
                {...(owner ? { sub: t("rightHand.settings.planOwner", { owner }) } : {})}
                chevron
                onPress={() => pick(a)}
              />
            );
          })}
        </GroupedList>
      ) : null}
      <GroupedFooter>
        {t(plans.length > 0 ? "rightHand.settings.workspacePlanHelp" : "rightHand.settings.noPlans", g)}
      </GroupedFooter>
    </>
  );
}

function Form({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const c = useColors();
  const toast = useToast();
  const failed = useFailed();
  const modelLabel = useModelLabel();
  const dir = useDirectory();
  const planKind = agent.brain && agent.brain.kind !== "model" ? agent.brain.kind : null;
  const key = useAgentBrain(orgId, agent.id, true, false, "workspace").data?.workspaceAi?.key;
  const roles = useRoles(orgId).data?.roles ?? [];
  const update = useUpdateAgent(orgId, agent.id);
  const [budget, setBudget] = useState(agent.monthlyBudgetUsd == null ? "" : String(agent.monthlyBudgetUsd));
  const g = agentGrammar(agent.name);
  const audience = audienceOf(agent);
  const picked = audience.mode === "people" ? audience.roleIds : [];
  const save = (patch: Parameters<typeof update.mutate>[0]) => update.mutate(patch, { onError: failed });
  const saveBudget = () => {
    const typed = budget.trim().replace(",", ".");
    const amount = typed === "" ? null : Number(typed);
    if (amount !== null && (!Number.isFinite(amount) || amount <= 0)) {
      toast({ title: t("agent.budgetInvalid"), icon: "x" });
      return;
    }
    if (amount !== (agent.monthlyBudgetUsd ?? null)) save({ monthlyBudgetUsd: amount });
  };
  // The people picked on the web stay; nobody and no role left picked: everyone again.
  const toggleRole = (id: string) => {
    const roleIds = picked.includes(id) ? picked.filter((r) => r !== id) : [...picked, id];
    const people = roleIds.length > 0 || audience.userIds.length > 0;
    save({
      audience: audiencePatch(people ? { ...audience, mode: "people", roleIds } : { ...audience, mode: "everyone" }),
    });
  };
  const everyone = audience.mode === "everyone";
  // Whether the narrowed audience holds for other agents too, as the web says under it.
  const reach = agentsReach(audience, false, agent.ownerUserId);
  return (
    <SettingsPage title={agent.name} subtitle={t("rightHand.label")}>
      <GroupedHeader>{t("rightHand.settings.name")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          leading={<AgentFace agentId={agent.id} size={36} live={false} />}
          label={agent.name}
          sub={`@${agent.handle}`}
          chevron
          onPress={() => openAgentEdit(agent.id)}
        />
      </GroupedList>
      <GroupedFooter>{t("rightHand.settings.nameHelp", { ...g, label: t("rightHand.label") })}</GroupedFooter>

      <GroupedHeader>{t("rightHand.settings.mine")}</GroupedHeader>
      <RightHandMine agent={agent} />

      <GroupedHeader>{t("rightHand.settings.workspace")}</GroupedHeader>
      {planKind ? (
        <PlanRows agent={agent} kind={planKind} dir={dir} />
      ) : (
        <>
          <GroupedList>
            <GroupedRow
              icon="brain"
              label={agent.model === AUTO ? t("brain.auto.label") : (modelLabel(agent.model) ?? agent.model)}
              {...(key ? { sub: key.label } : {})}
              chevron
              onPress={() => openAgentAi(agent.id)}
            />
          </GroupedList>
          <GroupedFooter>{t("rightHand.settings.workspaceHelp", g)}</GroupedFooter>
          <GroupedHeader>{t("rightHand.settings.workspacePlan")}</GroupedHeader>
          <WorkspacePlanRows agent={agent} dir={dir} />
        </>
      )}

      <GroupedHeader>{t("rightHand.settings.budget")}</GroupedHeader>
      <GroupedList>
        <View style={styles.budget}>
          <Text variant="body" tone="muted">
            US$
          </Text>
          <TextInput
            value={budget}
            onChangeText={setBudget}
            onEndEditing={saveBudget}
            keyboardType="decimal-pad"
            placeholder={t("rightHand.value.budgetDefault")}
            placeholderTextColor={c.faint}
            accessibilityLabel={t("rightHand.settings.budget")}
            style={[styles.amount, fieldText("body"), { color: c.ink }]}
          />
          <Text variant="body" tone="muted">
            {t("rightHand.settings.perMonth")}
          </Text>
        </View>
      </GroupedList>
      <GroupedFooter>{t("rightHand.settings.budgetHelp", g)}</GroupedFooter>

      <TeamWeekRows name={agent.name} />

      <GroupedHeader>{t("rightHand.settings.audience")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          icon="members"
          label={t("audience.mode.everyone")}
          checked={everyone}
          onPress={() => !everyone && save({ audience: audiencePatch({ ...audience, mode: "everyone" }) })}
        />
        {roles.map((r) => (
          <GroupedRow key={r.id} label={r.name} checked={picked.includes(r.id)} onPress={() => toggleRole(r.id)} />
        ))}
      </GroupedList>
      <GroupedFooter>
        {t("common.joinSentences", { a: t("rightHand.settings.audienceHelp", g), b: t("audience.rolesHint") })}
        {reach ? ` ${t(`audience.agents.${reach}`, g)}` : ""}
      </GroupedFooter>

      <Gap />
      <GroupedList>
        <GroupedRow
          icon="list"
          label={t("rightHand.settings.audit", g)}
          chevron
          onPress={() => router.push({ pathname: "/settings/audit", params: { agent: agent.id } } as never)}
        />
      </GroupedList>
      <GroupedFooter>{t("rightHand.settings.lock", g)}</GroupedFooter>
    </SettingsPage>
  );
}

/**
 * "Semana da equipe" (ADR 0137 §9): an admin's own day and hour of Lodi's weekly card, every day instead, or off;
 * anyone else's "Resumo do dia", every day or not at all, as on the web.
 */
function TeamWeekRows({ name }: { name: string }) {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const failed = useFailed();
  const admin = can(org, "administrator");
  const prefs = useTeamWeekPrefs(orgId).data;
  const set = useSetTeamWeekPrefs(orgId);
  if (!prefs) return null;
  const save = (patch: Parameters<typeof set.mutate>[0]) => set.mutate(patch, { onError: failed });
  const locale = i18n.language;
  const on = teamWeekOn(prefs, admin);
  const label = t(admin ? "teamWeek.settings.label" : "teamWeek.settings.dayLabel");
  return (
    <>
      <GroupedHeader>{label}</GroupedHeader>
      {/* The day and the hour are rows of the switch's group, as any settings group. */}
      <GroupedList>
        <GroupedRow
          icon="clock"
          label={label}
          toggle={on}
          onPress={() => save(admin ? { off: !prefs.off } : on ? { daily: false } : { daily: true, off: false })}
        />
        {on && admin ? (
          <Pills
            label={t("teamWeek.schedule.day")}
            value={prefs.daily ? EVERY_DAY : prefs.day}
            options={[
              ...[1, 2, 3, 4, 5, 6, 0].map((d) => ({ value: d, label: dayText(locale, d) })),
              { value: EVERY_DAY, label: t("teamWeek.schedule.daily") },
            ]}
            onPick={(day) => save(day === EVERY_DAY ? { daily: true } : { daily: false, day })}
          />
        ) : null}
        {!on ? null : (
          <Pills
            label={t("teamWeek.schedule.hour")}
            value={prefs.hour}
            options={Array.from({ length: 24 }, (_, h) => ({ value: h, label: hourText(locale, h) }))}
            onPick={(hour) => save({ hour })}
          />
        )}
      </GroupedList>
      <GroupedFooter>
        {t(admin ? "teamWeek.settings.help" : "teamWeek.settings.dayHelp", agentGrammar(name))}
      </GroupedFooter>
    </>
  );
}

/** The day pills' "every day" ("Resumo do dia"). */
const EVERY_DAY = -1;

/** A choice of a few short values as pills that wrap (the days, the hours), the picked one filled. */
function Pills({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: number;
  options: { value: number; label: string }[];
  onPick: (value: number) => void;
}) {
  const c = useColors();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.pills}>
      <Text variant="footnote" tone="muted" style={styles.pillsLabel}>
        {label}
      </Text>
      <View style={styles.pillRow}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <PressScale
              key={o.value}
              to={0.95}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              onPress={() => !on && onPick(o.value)}
              style={[styles.pill, { backgroundColor: on ? c.ink : c.sunken }]}
              contentStyle={styles.pillIn}
            >
              <Text variant="footnote" style={{ color: on ? c.bg : c.ink }}>
                {o.label}
              </Text>
            </PressScale>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Inside a group: its rows' 14 sides.
  pills: { paddingHorizontal: 14, paddingVertical: 12, gap: 8 },
  pillsLabel: { fontWeight: "600" },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  pill: { minHeight: 32, borderRadius: 10, borderBottomLeftRadius: 3 },
  // The whole pill presses: its padding is the press area's.
  pillIn: { paddingHorizontal: 12, justifyContent: "center" },
  // One row of a group: GroupedRow's 50 high and 14 sides.
  budget: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, minHeight: 50 },
  amount: { flex: 1, paddingVertical: 12 },
});
