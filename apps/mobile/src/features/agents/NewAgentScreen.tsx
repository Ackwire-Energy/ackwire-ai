import {
  type AgentProposal,
  ApiError,
  useAgentProposal,
  useApi,
  useBrainMachines,
  useCatalog,
  useChannels,
  useConnections,
  useCreateAgent,
  useCredentials,
  useCustomServers,
  useDenyAgentProposal,
  useDms,
  useModels,
  useNewAgentSetup,
  usePlatformKey,
  useSkills,
} from "@agenteschat/client";
import { LEVELS, type Level, nextLevel, saveLevels } from "@agenteschat/client/lib/access-levels";
import { draftLevels, draftMailLevels, suggestedAiText } from "@agenteschat/client/lib/action-cards";
import { newAgentStart, newAgentStartText } from "@agenteschat/client/lib/agent-setup";
import { connectedItems, itemName } from "@agenteschat/client/lib/connected";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { defaultPolicy, toMailLevel } from "@agenteschat/client/lib/mail";
import {
  cleanHandle,
  freeHandle,
  handleForName,
  handleProblem,
  presetChannels,
  presetLevels,
  ROLE_DEFAULTS,
  ROLE_GROUPS,
  type RoleId,
  savePart,
  takenHandles,
} from "@agenteschat/client/lib/new-agent";
import { addsAgentsTo, can } from "@agenteschat/client/lib/permissions";
import { modelChoices, usableModels } from "@agenteschat/client/lib/providers";
import { router, usePreventRemove } from "expo-router";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Pressable, ScrollView, type ScrollViewInstance, StyleSheet, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import { AgentAvatar, Button, Card, fieldText, Icon, InfoHint, Row, Text, Toggle, useToast } from "@/ui";
import { newAgentAi } from "../ai/logic";
import { openConnectAi } from "../ai/NoAiCard";
import { ConnectorIcon } from "../connectors/ConnectorIcon";
import { suggestAgentName } from "../new/logic";
import { useOpenDm } from "../new/useOpenDm";
import { useFailed } from "../routines/hooks";
import { proposedRoutineWhen } from "../routines/rule";
import { chooseAction } from "../settings/parts";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { PushedHeader, successHaptic, tapHaptic, useSurface } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { type FullLook, fullLook } from "./edit";
import { ErrorLine, HandleInput } from "./HandleInput";
import { LookPicker } from "./LookPicker";
import { firstBlockedStep, NEW_AGENT_PHONE_STEPS, type PhoneStep, stepBlocked } from "./new-agent";
import { RoleInput } from "./RoleInput";

/**
 * "Criar agente" on the phone, the web's steps for a thumb: Papel (the presets, grouped), Quem é
 * (name, @ and look), O que faz (the instructions, prefilled by the role) and Revisar (what it can use
 * and the channels it joins, from the role, and who thinks: the workspace's last setup or Automático,
 * ADR 0094). Budget and who it answers start at the workspace's defaults and change on its page.
 * Created, it opens the direct conversation with it. `initialWhat`
 * (an example in the empty Conversas) starts from scratch with that text. `proposalId` (an agent's
 * proposal card, ADR 0081) starts on Revisar, filled in with the draft, while the proposal is open.
 */
export function NewAgentScreen({
  initialWhat = "",
  proposalId = null,
}: {
  initialWhat?: string;
  proposalId?: string | null;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const proposal = useAgentProposal(orgId, proposalId);
  // The draft as it was when it opened: once created here the proposal is closed, and the form stays on.
  const opened = useRef<AgentProposal | null>(null);
  if (proposal.data?.canDecide && opened.current?.messageId !== proposal.data.messageId) opened.current = proposal.data;
  if (proposalId && !opened.current) {
    return (
      <View style={[styles.fill, { backgroundColor: c.bg }]}>
        <PushedHeader title={t("newAgent.title")} solid={false} />
        <View style={styles.body}>
          {proposal.isPending ? null : (
            <>
              <Text variant="body" tone="muted">
                {proposal.error instanceof ApiError && proposal.error.status === 403
                  ? t("newAgent.proposalNoAccess")
                  : t("newAgent.proposalClosed")}
              </Text>
              <Button variant="secondary" label={t("newAgent.backToChat")} onPress={() => router.back()} />
            </>
          )}
        </View>
      </View>
    );
  }
  return <NewAgentForm initialWhat={initialWhat} from={opened.current ?? undefined} />;
}

function NewAgentForm({ initialWhat, from }: { initialWhat: string; from?: AgentProposal }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const failed = useFailed();
  const api = useApi();
  const insets = useSafeAreaInsets();
  const orgId = useOrgId();
  const { org } = useOrg();
  const mayImport = can(org, "create_agents");
  // Giving a new agent apps is for who edits any agent: anyone else's starts without them (ADR 0085 §5).
  const managesAgents = can(org, "manage_agents");
  const meId = useMeId();
  const dir = useDirectory();
  const create = useCreateAgent(orgId);
  const openDm = useOpenDm();
  const catalog = useCatalog();
  const connections = useConnections(orgId);
  const servers = useCustomServers(orgId);
  const channels = useChannels(orgId);
  const dms = useDms(orgId);
  const library = useSkills(orgId);
  const scroll = useRef<ScrollViewInstance>(null);
  const lastSetup = useNewAgentSetup(orgId, mayImport);
  const brainMachines = useBrainMachines(orgId);
  const models = useModels();
  const credentials = useCredentials(orgId, can(org, "manage_credentials"));
  const platform = usePlatformKey(orgId);

  const suggested = suggestAgentName(dir.agents.map((a) => a.name));
  const proposed = from?.params.draft;
  const [index, setIndex] = useState(proposed ? NEW_AGENT_PHONE_STEPS.length - 1 : initialWhat ? 1 : 0);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState<RoleId | null>(proposed || initialWhat ? "custom" : null);
  const [roleText, setRoleText] = useState(proposed?.role ?? "");
  const [name, setName] = useState(proposed?.name ?? (initialWhat ? suggested : ""));
  const [handle, setHandle] = useState(proposed?.handle ?? (initialWhat ? handleForName(suggested) : ""));
  const [handleTouched, setHandleTouched] = useState(Boolean(proposed));
  const [look, setLook] = useState<FullLook>(fullLook(proposed?.appearance ?? ROLE_DEFAULTS.custom.look));
  const [instructions, setInstructions] = useState(proposed?.instructions ?? initialWhat);
  const [channelIds, setChannelIds] = useState<Set<string>>(new Set(proposed?.channelIds));
  // A proposal's levels are the reviewer's to change in Revisar; otherwise they come with the role.
  const [proposedLevels, setProposedLevels] = useState<Record<string, Level>>(() =>
    proposed && managesAgents ? draftLevels(proposed) : {},
  );
  // My own mailboxes it asked for, at its level (only a mailbox's owner gives an agent access to it), and its routine.
  const [mailLevels, setMailLevels] = useState<Record<string, Level>>(() =>
    proposed && meId ? draftMailLevels(proposed, meId) : {},
  );
  const [withRoutine, setWithRoutine] = useState(Boolean(proposed?.routine));
  // Who thinks (ADR 0094): the workspace's last setup where it can think for an agent of mine, unless a proposal says.
  const keys = credentials.data ?? [];
  const usable = usableModels(modelChoices(models.data?.models ?? [], keys, platform.data ?? false));
  const start = proposed ? null : newAgentStart(lastSetup.data, { ownerIsMe: true, usable, keys });
  const [useLast, setUseLast] = useState(true);
  const thinks = newAgentAi(start && useLast ? start : null);
  const startText = start
    ? newAgentStartText(t, i18n.language, start, {
        models: models.data?.models ?? [],
        machines: brainMachines.data ?? [],
        provider: lastSetup.data?.account?.provider,
      })
    : "";
  const created = useRef(false);
  const denied = useRef(false);
  const deny = useDenyAgentProposal(orgId);

  const step: PhoneStep = NEW_AGENT_PHONE_STEPS[index] ?? "role";
  const total = NEW_AGENT_PHONE_STEPS.length;
  const items = useMemo(
    () => connectedItems(connections.data ?? [], servers.data ?? [], catalog.data?.connectors ?? []),
    [connections.data, servers.data, catalog.data],
  );
  const levels = useMemo(
    () => (proposed ? proposedLevels : managesAgents ? presetLevels(role ?? "custom", items) : {}),
    [proposed, proposedLevels, role, items, managesAgents],
  );
  const granted = items.filter((i) => (levels[i.id] ?? "none") !== "none");
  const myMail = (proposed?.mail ?? []).filter((m) => m.accountId in mailLevels);
  // Revisar lists what a proposal asked for at any level, so a change can be taken back.
  const listedApps = proposed ? items.filter((i) => i.id in proposedLevels) : granted;
  // Mine, and the ones a proposal names: only where I may put an agent (in it and posting, or managing it).
  const myChannels = useMemo(() => {
    const dmIds = new Set((dms.data ?? []).map((d) => d.channelId));
    return (channels.data ?? []).filter(
      (ch) => (ch.isMember || proposed?.channelIds.includes(ch.id)) && !dmIds.has(ch.id) && addsAgentsTo(ch, meId, org),
    );
  }, [channels.data, dms.data, proposed, meId, org]);
  const taken = useMemo(() => takenHandles(dir.agents, [...dir.memberById.values()]), [dir.agents, dir.memberById]);
  const draft = { role, name, handle, taken };
  const shownName = name.trim() || t("newAgent.previewName");
  const g = agentGrammar(t, name.trim() || t("newAgent.defaultName"));
  const handleIssue = handle || tried ? handleProblem(handle, taken) : null;
  const handleText =
    handleIssue === "taken"
      ? t("newAgent.errors.handleTaken", { handle, suggestion: freeHandle(handle, taken) })
      : handleIssue === "format"
        ? t("newAgent.errors.handleFormat")
        : handleIssue === "empty"
          ? t("newAgent.errors.handleEmpty")
          : handle
            ? t("newAgent.handleHelp", { handle })
            : t("newAgent.handleEmpty");

  // Leaving with a draft asks first; the header's back leaves the whole flow.
  const dirty = role !== null || name.trim() !== "" || instructions.trim() !== "";
  usePreventRemove(dirty, ({ repeat }) => {
    if (created.current || denied.current) return repeat();
    Alert.alert(t("mobile.newAgent.leaveTitle"), t("mobile.newAgent.leaveText"), [
      { text: t("mobile.newAgent.keepGoing"), style: "cancel" },
      { text: t("newAgent.leave"), style: "destructive", onPress: repeat },
    ]);
  });

  const goTo = (i: number) => {
    setTried(false);
    setIndex(Math.max(0, Math.min(total - 1, i)));
    scroll.current?.scrollTo({ y: 0, animated: false });
  };
  const pickRole = (id: RoleId) => {
    tapHaptic();
    setRole(id);
    // A new role fills in the rest. The role it already has keeps what was typed, and a proposal keeps its draft.
    if (id !== role && !proposed) {
      const agentName = id === "custom" ? "" : t(`newAgent.roles.${id}.agent`);
      setRoleText("");
      setName(agentName);
      setHandle(handleForName(agentName));
      setHandleTouched(false);
      setLook(fullLook(ROLE_DEFAULTS[id].look));
      setInstructions(t(`newAgent.roles.${id}.instructions`));
      setChannelIds(new Set(presetChannels(id, myChannels)));
    }
    // A tap is the answer: on to the next step, or back to Revisar on a proposal.
    setTimeout(() => goTo(proposed ? total - 1 : 1), 180);
  };
  const refuse = () => {
    if (!from) return;
    deny.mutate(from.messageId, {
      onSuccess: () => {
        denied.current = true;
        router.back();
      },
      onError: failed,
    });
  };
  const changeName = (value: string) => {
    setName(value);
    if (!handleTouched) setHandle(handleForName(value));
  };

  const submit = async () => {
    const bad = firstBlockedStep(draft);
    if (bad >= 0) {
      goTo(bad);
      setTried(true);
      return;
    }
    setBusy(true);
    try {
      const agent = await create.mutateAsync({
        name: name.trim(),
        handle,
        role: role && role !== "custom" ? t(`newAgent.roles.${role}.name`) : roleText.trim(),
        instructions,
        model: thinks.model,
        ownerUserId: meId ?? null,
        audience: { mode: "everyone", userIds: [] },
        credentialId: thinks.credentialId,
        monthlyBudgetUsd: null,
        appearance: look,
        ...(from ? { proposal: from.messageId } : {}),
        ...(thinks.autonomy ? { autonomy: thinks.autonomy } : {}),
      });
      created.current = true;
      // What the role brings, as the web's last step: its channels, its apps' levels, the default skills. One part
      // at a time, so a refused one doesn't keep the rest (the AI below too) from saving.
      const failures: unknown[] = [];
      const joined = myChannels.filter((ch) => channelIds.has(ch.id));
      if (joined.length > 0)
        await savePart(failures, () =>
          api.agents.setChannels(
            orgId,
            agent.id,
            joined.map((ch) => ({ channelId: ch.id })),
          ),
        );
      const chosen = Object.fromEntries(granted.map((i) => [`connector:${i.id}`, levels[i.id] as Level]));
      if (Object.keys(chosen).length > 0) await savePart(failures, () => saveLevels(api, orgId, agent.id, chosen));
      const list = library.data ?? [];
      if (list.length > 0)
        await savePart(failures, () =>
          api.skills.setForAgent(
            orgId,
            agent.id,
            list.map((s) => ({ skillId: s.id, enabled: s.defaultForNewAgents })),
          ),
        );
      // The AI the server suggests for me: an account of mine on its computer; the workspace's model needs nothing.
      const ai = proposed?.ai;
      if (ai?.kind === "account") {
        await savePart(failures, async () => {
          await api.sandbox.setTarget(orgId, agent.id, ai.machineId);
          await api.agents.setBrain(orgId, agent.id, { brain: ai.brain, account: ai.accountId });
        });
      }
      // Or the last setup's plan, with its model, effort and the rest; on the API, its context window.
      const plan = thinks.plan;
      if (plan) {
        await savePart(failures, async () => {
          await api.sandbox.setTarget(orgId, agent.id, plan.machineId);
          await api.agents.setBrain(orgId, agent.id, plan.input);
        });
      } else if (thinks.contextTokens !== null) {
        const contextTokens = thinks.contextTokens;
        await savePart(failures, () => api.agents.setBrain(orgId, agent.id, { brain: "model", contextTokens }));
      }
      // My own mailboxes at the level chosen here (every send asks), then its routine, now that it is where it reports.
      for (const [accountId, level] of Object.entries(mailLevels)) {
        if (level === "none") continue;
        await savePart(failures, () =>
          api.mail.setAgent(orgId, agent.id, accountId, {
            level: toMailLevel(level),
            canDelete: false,
            policy: defaultPolicy(),
          }),
        );
      }
      if (from && proposed?.routine && withRoutine)
        await savePart(failures, () => api.agents.proposalRoutine(orgId, from.messageId));
      if (failures.length > 0) toast({ title: t("mobile.newAgent.partly"), icon: "x" });
      else {
        successHaptic();
        toast({ title: t("mobile.agents.created", { name: agent.name }), agentId: agent.id });
      }
      if (from) {
        // From its card: back to that conversation as it was, Connect over it when it has nothing to think with.
        router.back();
        if (ai?.kind === "none") openConnectAi({ agentId: agent.id });
        return;
      }
      // It exists either way (Criar again would only find its @ taken): on to its conversation, where Connect opens
      // when it has nothing to think with yet.
      void openDm({ agentId: agent.id }).then(() => {
        if (ai?.kind === "none") openConnectAi({ agentId: agent.id });
      });
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };
  const next = () => {
    if (busy) return;
    if (stepBlocked(step, draft)) {
      setTried(true);
      return;
    }
    if (index === total - 1) void submit();
    else goTo(index + 1);
  };

  const head = (title: string, lead?: string) => (
    <View style={styles.head}>
      <Text variant="display2" accessibilityRole="header">
        {title}
      </Text>
      {lead ? (
        <Text variant="body" tone="muted">
          {lead}
        </Text>
      ) : null}
    </View>
  );
  const input = [styles.input, fieldText("body"), { backgroundColor: c.raised, color: c.ink, borderColor: c.line }];
  const usesTitle = (
    <Text variant="title" accessibilityRole="header">
      {t("newAgent.preview.uses")}
    </Text>
  );

  const views: Record<PhoneStep, () => ReactNode> = {
    role: () => (
      <>
        {head(t("newAgent.steps.role.title"), t("newAgent.steps.role.lead"))}
        {mayImport && !proposed ? (
          <Button
            variant="secondary"
            size="sm"
            icon="archive"
            label={t("shell.importAgents")}
            onPress={() => router.push("/settings/import")}
          />
        ) : null}
        <View style={styles.group}>
          <RoleCard
            on={role === "custom"}
            onPress={() => pickRole("custom")}
            leading={
              <View style={[styles.blank, { borderColor: c.line2 }]}>
                <Icon name="plus" size={20} color={c.muted} />
              </View>
            }
            title={t("newAgent.roles.custom.name")}
            desc={t("newAgent.roles.custom.desc")}
          />
          {role === "custom" ? (
            <RoleInput value={roleText} onChangeText={setRoleText} placeholder={t("agent.roleHelp")} />
          ) : null}
        </View>
        {ROLE_GROUPS.map((group) => (
          <View key={group.id} style={styles.group}>
            <Text variant="footnote" tone="faint" style={styles.groupTitle}>
              {t(`newAgent.roleGroups.${group.id}`)}
            </Text>
            {group.roles.map((id) => (
              <RoleCard
                key={id}
                on={role === id}
                onPress={() => pickRole(id)}
                leading={<AgentAvatar agent={fullLook(ROLE_DEFAULTS[id].look)} size={44} live={false} />}
                title={t(`newAgent.roles.${id}.name`)}
                caption={t("newAgent.startsAs", { name: t(`newAgent.roles.${id}.agent`) })}
                desc={t(`newAgent.roles.${id}.desc`)}
              />
            ))}
          </View>
        ))}
        {tried && !role ? <ErrorLine text={t("newAgent.errors.roleRequired")} /> : null}
      </>
    ),
    identity: () => (
      <>
        {head(t("newAgent.steps.identity.title"), t("newAgent.steps.identity.lead"))}
        <View style={styles.hero}>
          <AgentAvatar agent={look} size={104} name={shownName} />
        </View>
        <Text variant="footnote" tone="faint">
          {t("newAgent.name")}
        </Text>
        <TextInput
          value={name}
          onChangeText={changeName}
          maxLength={32}
          autoCorrect={false}
          placeholder={t("newAgent.namePlaceholder")}
          placeholderTextColor={c.faint}
          accessibilityLabel={t("newAgent.name")}
          style={input}
        />
        {tried && !name.trim() ? <ErrorLine text={t("newAgent.errors.nameRequired")} /> : null}
        <Text variant="footnote" tone="faint" style={styles.gapTop}>
          {t("newAgent.handle")}
        </Text>
        <HandleInput
          value={handle}
          onChangeText={(v) => {
            setHandleTouched(true);
            setHandle(cleanHandle(v));
          }}
          label={t("newAgent.handle")}
          placeholder={t("newAgent.handlePlaceholder")}
        />
        {handleIssue ? (
          <ErrorLine text={handleText} />
        ) : (
          <Text variant="footnote" tone="faint">
            {handleText}
          </Text>
        )}
        <View style={styles.section}>
          <Text variant="title" accessibilityRole="header">
            {t("newAgent.look")}
          </Text>
          <LookPicker look={look} onChange={setLook} />
        </View>
      </>
    ),
    instructions: () => (
      <>
        {head(t("newAgent.steps.instructions.title", g), t("newAgent.steps.instructions.lead"))}
        <TextArea
          value={instructions}
          onChangeText={setInstructions}
          placeholder={t("newAgent.instructionsPlaceholder")}
          accessibilityLabel={t("newAgent.instructions")}
          minHeight={220}
          scrollEnabled={false}
        />
        {role && role !== "custom" && instructions !== t(`newAgent.roles.${role}.instructions`) ? (
          <View style={styles.restore}>
            <Text variant="footnote" tone="faint" style={styles.fill}>
              {t("newAgent.startedFrom", { role: t(`newAgent.roles.${role}.name`) })}
            </Text>
            <Button
              variant="secondary"
              size="sm"
              label={t("newAgent.restore")}
              onPress={() => setInstructions(t(`newAgent.roles.${role}.instructions`))}
            />
          </View>
        ) : null}
        {!instructions.trim() ? (
          <Text variant="footnote" tone="faint">
            {t("newAgent.noInstructions", g)}
          </Text>
        ) : null}
      </>
    ),
    review: () => (
      <>
        {head(t("newAgent.steps.review.title", g), t("newAgent.hints.review"))}
        <Card>
          <Row
            leading={<AgentAvatar agent={look} size={44} name={shownName} />}
            title={shownName}
            subtitle={`@${handle}`}
            chevron
            onPress={() => goTo(1)}
          />
          <Row
            title={t("newAgent.steps.role.name")}
            meta={
              <Text variant="small" tone="muted">
                {role && role !== "custom"
                  ? t(`newAgent.roles.${role}.name`)
                  : roleText || t("newAgent.roles.custom.name")}
              </Text>
            }
            chevron
            onPress={() => goTo(0)}
          />
          <Row
            title={t("newAgent.instructions")}
            subtitle={instructions.trim().split("\n")[0] || t("newAgent.onlyContext")}
            chevron
            onPress={() => goTo(2)}
          />
        </Card>
        {proposed ? (
          <Text variant="footnote" tone="muted">
            {suggestedAiText(t, proposed.ai)}
          </Text>
        ) : null}
        {start ? (
          <Card>
            <Row
              title={t("brain.title")}
              subtitle={useLast ? t("newAgent.lastSetup", { setup: startText }) : t("brain.auto.label")}
              subtitleLines={2}
              chevron
              onPress={() =>
                chooseAction(
                  t("brain.title"),
                  [
                    { label: startText, onPress: () => setUseLast(true) },
                    { label: t("brain.auto.label"), onPress: () => setUseLast(false) },
                  ],
                  t("common.cancel"),
                )
              }
            />
          </Card>
        ) : null}

        <View style={styles.section}>
          {managesAgents ? (
            usesTitle
          ) : (
            <InfoHint
              name={t("common.about", { label: t("newAgent.preview.uses") })}
              text={t("newAgent.accessAdmins")}
              variant="title"
            >
              {usesTitle}
            </InfoHint>
          )}
          {listedApps.length > 0 ? (
            <Card>
              {listedApps.map((i) => {
                const level = levels[i.id] ?? "none";
                return (
                  <Row
                    key={i.id}
                    leading={<ConnectorIcon def={i.def} image={i.image} label={itemName(t, i)} size={32} />}
                    title={itemName(t, i)}
                    meta={
                      <Text variant="small" tone="muted">
                        {proposed
                          ? t(`access.level.${level}`)
                          : t(`mobile.intentAgents.uses.level.${level === "write" ? "write" : "read"}`)}
                      </Text>
                    }
                    {...(proposed
                      ? {
                          onPress: () => {
                            tapHaptic();
                            setProposedLevels((p) => ({ ...p, [i.id]: nextLevel({ levels: LEVELS }, level) }));
                          },
                        }
                      : {})}
                  />
                );
              })}
            </Card>
          ) : myMail.length === 0 ? (
            <Text variant="footnote" tone="faint">
              {t("newAgent.preview.onlyTalks")}
            </Text>
          ) : null}
          {myMail.length > 0 ? (
            <Card>
              {myMail.map((box) => {
                const level = mailLevels[box.accountId] ?? "none";
                return (
                  <Row
                    key={box.accountId}
                    leading={<Icon name="mail" size={20} color={c.muted} />}
                    title={box.address}
                    meta={
                      <Text variant="small" tone="muted">
                        {t(`access.level.${level}`)}
                      </Text>
                    }
                    onPress={() => {
                      tapHaptic();
                      setMailLevels((p) => ({ ...p, [box.accountId]: nextLevel({ levels: LEVELS }, level) }));
                    }}
                  />
                );
              })}
            </Card>
          ) : null}
          <Text variant="footnote" tone="faint">
            {proposed && listedApps.length + myMail.length > 0
              ? `${t("mobile.settings.access.how")} ${t("newAgent.approvalsNote")}`
              : t("newAgent.approvalsNote")}
          </Text>
        </View>

        {proposed?.routine ? (
          <View style={styles.section}>
            <Text variant="title" accessibilityRole="header">
              {t("newAgent.routine")}
            </Text>
            <Card>
              <Toggle
                label={`${proposed.routine.name} · ${proposedRoutineWhen(t, i18n.language, proposed.routine)}`}
                value={withRoutine}
                onChange={setWithRoutine}
              />
            </Card>
            <Text variant="footnote" tone="faint">
              {proposed.routine.prompt}
            </Text>
          </View>
        ) : null}

        <View style={styles.section}>
          <Text variant="title" accessibilityRole="header">
            {t("newAgent.channels")}
          </Text>
          {myChannels.length > 0 ? (
            <Card>
              {myChannels.map((ch) => (
                <Toggle
                  key={ch.id}
                  label={`#${ch.name}`}
                  value={channelIds.has(ch.id)}
                  onChange={(on) =>
                    setChannelIds((prev) => {
                      const nextSet = new Set(prev);
                      if (on) nextSet.add(ch.id);
                      else nextSet.delete(ch.id);
                      return nextSet;
                    })
                  }
                />
              ))}
            </Card>
          ) : null}
          <Text variant="footnote" tone="faint">
            {myChannels.length > 0 ? t("newAgent.channelsHelp") : t("newAgent.noChannels")}
          </Text>
        </View>
        {from ? (
          <Button variant="secondary" label={t("approval.refuse")} disabled={busy || deny.isPending} onPress={refuse} />
        ) : null}
      </>
    ),
  };

  return (
    <View style={[styles.fill, { backgroundColor: c.bg }]}>
      <PushedHeader
        title={t("newAgent.title")}
        subtitle={t("newAgent.stepOf", { n: index + 1, total })}
        solid={false}
      />
      <KeyboardAvoidingView behavior="padding" style={styles.fill}>
        <ScrollView
          ref={scroll}
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.body}
        >
          <Steps index={index} total={total} />
          {views[step]()}
        </ScrollView>
        <View style={[styles.footer, { borderTopColor: c.line, paddingBottom: Math.max(insets.bottom, 12) }]}>
          {index > 0 ? <Button variant="secondary" label={t("common.back")} onPress={() => goTo(index - 1)} /> : null}
          {step !== "role" || role ? (
            <View style={styles.fill}>
              <Button
                variant="primary"
                wide
                label={
                  index === total - 1 ? t("newAgent.create", { name: name.trim() || shownName }) : t("common.continue")
                }
                disabled={busy}
                onPress={next}
              />
            </View>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

/** Where the person is, as dots (the web's step rail, small). */
function Steps({ index, total }: { index: number; total: number }) {
  const c = useColors();
  return (
    <View style={styles.dots} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: total }, (_, i) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: one dot per step, in order
          key={i}
          style={[styles.dot, { backgroundColor: i <= index ? c.ink : c.line2 }, i === index && styles.dotOn]}
        />
      ))}
    </View>
  );
}

function RoleCard({
  on,
  onPress,
  leading,
  title,
  caption,
  desc,
}: {
  on: boolean;
  onPress: () => void;
  leading: ReactNode;
  title: string;
  caption?: string;
  desc: string;
}) {
  const c = useColors();
  const surface = useSurface();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      accessibilityLabel={[title, caption, desc].filter(Boolean).join(". ")}
      style={({ pressed }) => [
        styles.role,
        surface,
        { borderColor: on ? c.ink : "transparent" },
        pressed && styles.pressed,
      ]}
    >
      {leading}
      <View style={styles.fill}>
        <Text variant="body" style={styles.bold}>
          {title}
        </Text>
        {caption ? (
          <Text variant="footnote" tone="muted">
            {caption}
          </Text>
        ) : null}
        <Text variant="footnote" tone="ink2" style={styles.desc}>
          {desc}
        </Text>
      </View>
      {on ? <Icon name="checkc" size={22} color={c.ink} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { paddingHorizontal: 18, paddingBottom: 32, gap: 8 },
  head: { gap: 6, marginBottom: 10 },
  group: { gap: 8, marginTop: 8 },
  groupTitle: { marginTop: 6 },
  role: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 20,
    borderWidth: 2,
  },
  blank: {
    width: 44,
    height: 44,
    borderRadius: 15,
    borderWidth: 1.5,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
  },
  bold: { fontWeight: "600" },
  desc: { marginTop: 2 },
  pressed: { transform: [{ scale: 0.98 }] },
  hero: { alignItems: "center", paddingVertical: 8 },
  input: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 12 },
  gapTop: { marginTop: 10 },
  section: { marginTop: 22, gap: 10 },
  restore: { flexDirection: "row", alignItems: "center", gap: 10 },
  footer: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 18,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  dots: { flexDirection: "row", gap: 6, marginBottom: 14, marginTop: 4 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  dotOn: { width: 18 },
});
