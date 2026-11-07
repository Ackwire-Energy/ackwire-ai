import type { Agent, SetupStep } from "@agenteschat/client";
import { useAgentAccess, useAgentDetail, useAiStatus, useMe } from "@agenteschat/client";
import { levelOf, resourcesOf } from "@agenteschat/client/lib/access-levels";
import { audienceOf } from "@agenteschat/client/lib/audience";
import { firstName, joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { aiStateOf } from "@agenteschat/client/lib/no-ai";
import { addsAgentsTo, can } from "@agenteschat/client/lib/permissions";
import {
  askedLine,
  nextStep,
  setupDone,
  setupRole,
  setupRow,
  setupSteps,
  setupTaskKeys,
  suggestedChannels,
  suggestedLevels,
} from "@agenteschat/client/lib/setup-checklist";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, Card, Icon, type IconName, Text } from "@/ui";
import { openConnectAi } from "../../ai/NoAiCard";
import { requestComposerText } from "../../chat/composer-request";
import { useOpenDm } from "../../new/useOpenDm";
import { resourceName, useConnectedById } from "../../settings/hooks";
import { AgentFace } from "../../shared/Face";
import { useColors, useDirectory, useMeId } from "../../shared/hooks";
import { successHaptic, tapHaptic } from "../../shared/parts";
import { openSetupStep } from "./SetupStepScreen";
import { useAgentChannels } from "./useAgentChannels";

/*
 * A new agent's setup checklist on the phone (ADR 0152 §2), as on the web: the top of its DM, drawn by the app and
 * never stored, in its voice. Five steps (think, apps, channels, who talks to it, how it works); each button opens a
 * screen of its own with the suggestion marked (managing is a pushed screen), think opens Connect AI. Only who may set
 * the agent up sees it: who manages agents all the steps, its owner the ones they may change. Its screen shows the
 * same card while something is left.
 */

const STEP_ICON: Record<SetupStep, IconName> = {
  ai: "brain",
  apps: "bolt",
  where: "hash",
  who: "members",
  how: "doc",
};

/** The steps this person sees for this agent (none: the checklist isn't theirs, or the agent has none). */
export function useSetupSteps(agent: Agent | undefined): SetupStep[] {
  const { org } = useOrg();
  const meId = useMeId();
  return agent && meId ? setupSteps(agent, { meId, admin: can(org, "manage_agents") }) : [];
}

/** The top of a new agent's DM: its greeting and the checklist, as its first message. */
export function AgentSetupIntro({ agent, channelId }: { agent: Agent; channelId: string }) {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const g = agentGrammar(agent.name);
  const role = setupRole(agent.setup);
  const person = firstName(me.data?.user.name ?? "");
  const asked = role ? null : askedLine(agent.instructions);
  const roleName = role ? roleWord(t(`newAgent.roles.${role}.name`), i18n.language) : null;
  const greeting = roleName
    ? t("agentSetup.greetingRole", { ...g, person, role: roleName })
    : t("agentSetup.greeting", { ...g, person });
  return (
    <View style={styles.intro}>
      <View style={styles.head}>
        <AgentFace agentId={agent.id} size={36} />
        <Text variant="body" style={styles.bold}>
          {agent.name}
        </Text>
      </View>
      <View style={styles.text}>
        <Text variant="body" tone="ink2">
          {[greeting, asked ? t("agentSetup.asked", { what: asked }) : null, t("agentSetup.lead")]
            .filter(Boolean)
            .join(" ")}
        </Text>
        <AgentSetupCard agent={agent} place="dm" channelId={channelId} />
      </View>
    </View>
  );
}

/** "Atendimento" → "atendimento" in a sentence; an acronym ("QA") stays as it is. */
const roleWord = (name: string, locale: string) =>
  name.length <= 3 && name === name.toUpperCase() ? name : name.toLocaleLowerCase(locale);

/**
 * The checklist card. `dm`: under the agent's greeting, in its voice ("To get started"), its first tasks filling the
 * composer of `channelId`; `profile`: on its screen ("For Leo to get started"), gone once everything is done, its
 * first tasks opening its DM with the text written.
 */
export function AgentSetupCard({
  agent,
  place,
  channelId,
}: {
  agent: Agent;
  place: "dm" | "profile";
  channelId?: string;
}) {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const c = useColors();
  const dir = useDirectory();
  const meId = useMeId();
  const openDm = useOpenDm();
  const admin = can(org, "manage_agents");
  const steps = useSetupSteps(agent);
  const status = useAiStatus(orgId);
  const access = useAgentAccess(orgId, agent.id, admin && steps.includes("apps"));
  const detail = useAgentDetail(orgId, agent.id);
  const visible = useAgentChannels();
  const items = useConnectedById();
  const [said, setSaid] = useState<{ step: SetupStep; text: string } | null>(null);
  const g = agentGrammar(agent.name);
  const role = setupRole(agent.setup);

  const connectors = access.data ? resourcesOf(access.data).filter((r) => r.kind === "connector") : [];
  const granted = connectors.filter((r) => levelOf(r) !== "none");
  const visibleIds = new Set(visible.list.map((ch) => ch.id));
  const inChannels = (detail.data?.channels ?? []).filter((ch) => visibleIds.has(ch.id));
  const aiState = aiStateOf(status.data, agent.id);
  const done = agent.setup
    ? setupDone(agent.setup, {
        ai: aiState === "ready" || aiState === "waiting",
        apps: granted.length > 0,
        where: inChannels.length > 0,
      })
    : new Set<SetupStep>();
  const doneHere = steps.filter((s) => done.has(s));
  const all = doneHere.length === steps.length;
  const next = nextStep(steps, done);

  // Everything it reads has loaded: a step that turns done after this was done now (its line and a haptic).
  const ready = status.isSuccess && detail.isSuccess && visible.ready && (!steps.includes("apps") || !access.isPending);
  const seen = useRef<Set<SetupStep> | null>(null);
  const sayTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const doneKey = doneHere.join();
  const name = agent.name;
  useEffect(() => {
    if (!ready) return;
    const now = new Set(doneKey ? (doneKey.split(",") as SetupStep[]) : []);
    const before = seen.current;
    seen.current = now;
    if (!before) return;
    const fresh = [...now].find((s) => !before.has(s));
    if (!fresh) return;
    successHaptic();
    setSaid({ step: fresh, text: t(`agentSetup.say.${fresh}`, agentGrammar(name)) });
    clearTimeout(sayTimer.current);
    sayTimer.current = setTimeout(() => setSaid(null), 2600);
  }, [ready, doneKey, name, t]);
  useEffect(() => () => clearTimeout(sayTimer.current), []);

  if (steps.length === 0 || (place === "profile" && all)) return null;

  const names = (list: typeof connectors) =>
    joinNames(
      list.map((r) => resourceName(t, r, items)),
      t,
    );
  const suggested = suggestedLevels(role);
  const suggestedApps = connectors.filter((r) => r.connector && suggested[r.connector]);
  const placeable = visible.list.filter((ch) => addsAgentsTo(ch, meId, org));
  const firstChannel = placeable.find((ch) => suggestedChannels(role, placeable).includes(ch.id));
  const audience = audienceOf(agent);
  const owner = agent.ownerUserId ? dir.memberById.get(agent.ownerUserId) : undefined;
  const ownerIsMe = Boolean(meId && agent.ownerUserId === meId);
  const rowOf = (step: SetupStep) =>
    setupRow(t, step, done.has(step), {
      org: org?.name ?? "",
      role,
      granted: granted.length ? names(granted) : null,
      suggested: suggestedApps.length ? names(suggestedApps) : null,
      channels: inChannels.length
        ? joinNames(
            inChannels.map((ch) => `#${ch.name}`),
            t,
          )
        : null,
      firstChannel: firstChannel ? `#${firstChannel.name}` : null,
      audience: audience.mode,
      otherOwner: !ownerIsMe && owner ? firstName(owner.name) : null,
      onPlan: Boolean(agent.brain && agent.brain.kind !== "model"),
    });

  const act = (step: SetupStep) => {
    tapHaptic();
    if (step === "ai") openConnectAi({ agentId: agent.id });
    else openSetupStep(agent.id, step);
  };

  // Its role's first tasks (a blank agent's own two); a key a language lacks is left out.
  const anyKey = t as unknown as (key: string) => string;
  const tasks = setupTaskKeys(role)
    .filter((key) => i18n.exists(key))
    .map((key) => anyKey(key));
  const ask = (text: string) => {
    tapHaptic();
    if (place === "dm" && channelId) requestComposerText(channelId, text);
    else void openDm({ agentId: agent.id }, { compose: true, text });
  };

  const title =
    place === "dm" ? (all ? t("agentSetup.ready", g) : t("agentSetup.title")) : t("agentSetup.titleProfile", g);
  return (
    <Card style={styles.card}>
      <View style={styles.inner} accessibilityLabel={title}>
        <View style={styles.cardHead}>
          <Text variant="subhead" style={[styles.bold, styles.fill]} accessibilityRole="header">
            {title}
          </Text>
          <Text variant="caption" tone="muted">
            {t("agentSetup.count", { done: doneHere.length, total: steps.length })}
          </Text>
        </View>
        <View style={styles.meter} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {steps.map((s, i) => (
            <View key={s} style={[styles.seg, { backgroundColor: i < doneHere.length ? c.ink : c.line2 }]} />
          ))}
        </View>
        <View accessibilityLiveRegion="polite">
          {steps.map((s, i) => {
            const row = rowOf(s);
            const isDone = done.has(s);
            const saying = said?.step === s ? said.text : null;
            return (
              <View
                key={s}
                style={[styles.row, i > 0 && { borderTopColor: c.line, borderTopWidth: StyleSheet.hairlineWidth }]}
              >
                {isDone ? (
                  <View style={[styles.check, { backgroundColor: c.ink }]}>
                    <Icon name="check" size={12} color={c.bg} />
                  </View>
                ) : (
                  <View style={styles.lead}>
                    <Icon name={STEP_ICON[s]} size={18} color={c.ink2} />
                  </View>
                )}
                <View style={styles.fill}>
                  <Text variant="small" tone={isDone ? "ink2" : "ink"} style={isDone ? undefined : styles.bold}>
                    {row.title}
                  </Text>
                  {saying ? (
                    <Text variant="caption" tone="ok">
                      {saying}
                    </Text>
                  ) : !isDone && row.desc ? (
                    <Text variant="caption" tone="muted">
                      {row.desc}
                    </Text>
                  ) : null}
                </View>
                {isDone ? (
                  <Button variant="text" size="sm" label={row.action} onPress={() => act(s)} />
                ) : (
                  <Button
                    variant={s === next ? "primary" : "secondary"}
                    size="sm"
                    label={row.action}
                    onPress={() => act(s)}
                  />
                )}
              </View>
            );
          })}
        </View>
        {done.has("ai") && tasks.length > 0 ? (
          <View style={[styles.foot, { borderTopColor: c.line }]}>
            <Text variant="small" style={styles.bold}>
              {all ? t("agentSetup.tasksAllDone") : t("agentSetup.tasksLead")}
            </Text>
            {tasks.map((task) => (
              <Pressable
                key={task}
                onPress={() => ask(task)}
                accessibilityRole="button"
                accessibilityLabel={task}
                style={({ pressed }) => [
                  styles.task,
                  { borderColor: c.line2 },
                  pressed && { backgroundColor: c.sunken },
                ]}
              >
                <Icon name="chat" size={16} color={c.ink2} />
                <Text variant="small" style={styles.fill}>
                  {task}
                </Text>
                <Icon name="right" size={16} color={c.faint} />
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  intro: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, gap: 6 },
  head: { flexDirection: "row", alignItems: "center", gap: 10 },
  text: { gap: 10 },
  bold: { fontWeight: "600" },
  fill: { flex: 1, minWidth: 0 },
  card: { marginTop: 2 },
  inner: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  meter: { flexDirection: "row", gap: 4, marginTop: 10, marginBottom: 4 },
  seg: { flex: 1, height: 4, borderRadius: 2 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12 },
  lead: { width: 22, alignItems: "center" },
  check: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  foot: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12, paddingBottom: 8, gap: 8 },
  task: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
});
