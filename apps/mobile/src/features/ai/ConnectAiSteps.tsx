import type { MachineAccount } from "@agenteschat/client";
import { keys, useAgentBrain, useAiAccounts, useApi, useComputerSetup, useMachines } from "@agenteschat/client";
import { computerEdition, computerName, setupView } from "@agenteschat/client/lib/computer";
import { holdText } from "@agenteschat/client/lib/errors";
import { agentGrammar, providerGrammar } from "@agenteschat/client/lib/grammar";
import {
  type AiChoice,
  firstAgent,
  gateDims,
  KEY_MARKS,
  kindOf,
  type PlanChoice,
  type PlanGate,
  planGate,
  planLabel,
  planMark,
  planTitle,
} from "@agenteschat/client/lib/no-ai";
import { isPlanId, PLAN_IDS } from "@agenteschat/client/lib/plans";
import { keyLooksValid, keyStepHint, PROVIDERS, providerOf, providersForKey } from "@agenteschat/client/lib/providers";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActionSheetIOS, ActivityIndicator, Alert, Platform, Pressable, StyleSheet, View } from "react-native";
import {
  Button,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Icon,
  type IconName,
  ProviderLogo,
  ProviderQuad,
  Text,
  useTheme,
  useToast,
} from "@/ui";
import { SetupWait } from "../computer/SetupWait";
import { SheetHeader } from "../new/parts";
import { AgentFace } from "../shared/Face";
import { AddAccount } from "./AddAccount";
import type { ConnectKey } from "./ConnectAi";
import { offersKeyNow, PLAN_POLL_MS, pollsPlan } from "./logic";
import { useAiOrg } from "./org";
import { Note, OpenPage, PasteField, Step, StepsCard } from "./parts";

/*
 * "Conectar uma IA" on the phone: the web's content and rules
 * (ADR 0059, ADR 0061) in the app's own line. The first page is two grouped lists like iOS Settings: your AI plan
 * (Claude, ChatGPT, the coding plans in one row) and pay as you go (the API key). Each row pushes its page inside
 * the sheet: a plan's mark, for which agent, and its numbered steps on the agent's computer (or why they wait); the
 * key's maker as a radio list, where its keys are made, and the key. A plan signs in on the agent's computer: with
 * none, "Conectar um computador", and the key stays one tap away.
 */

/**
 * What each plan can do now for one agent (`planGate`), from its brain view, its computer's row and the setup.
 * `poll`: asked again this often while a plan waits (the first run opens no socket, so nothing else keeps them
 * current there).
 */
export function usePlanGates(orgId: string, agentId: string | undefined, poll: number | false = false) {
  const brain = useAgentBrain(orgId, agentId ?? "", agentId !== undefined, poll);
  const ai = useAiAccounts(orgId, agentId !== undefined, poll);
  const setupQ = useComputerSetup(orgId, true, poll);
  const edition = computerEdition(setupQ.data);
  const setup = setupView(setupQ.data, setupQ.dataUpdatedAt);
  const view = brain.data;
  const row = ai.data?.computers.find((c) => c.machineId === view?.computer?.machineId);
  // Once ready, the workspace's computer is every agent's: a view from before that still has none is asked again
  // now with the accounts (a coding plan reads that computer's row there), not at their next poll. Until both
  // answers are in, every plan reads as ready with its sign-in loading, as the rest of the page says ready.
  const behind = edition === "cloud" && setup?.phase === "ready" && view !== undefined && !view.computer;
  const [asking, setAsking] = useState(false);
  const { refetch: brainAgain } = brain;
  const { refetch: accountsAgain } = ai;
  useEffect(() => {
    if (!behind) return;
    setAsking(true);
    void Promise.allSettled([brainAgain(), accountsAgain()]).then(() => setAsking(false));
  }, [behind, brainAgain, accountsAgain]);
  const catching = behind || asking;
  // A plan's page waited for that computer: once it's ready, it says so whenever a plan's page shows again
  // (another plan, the key's page and back). Kept here, above the pages.
  const [waited, setWaited] = useState(false);
  const markWaited = useCallback(() => setWaited(true), []);
  const gateOf = (choice: PlanChoice): PlanGate =>
    catching
      ? { state: "ready" }
      : planGate({
          choice,
          edition,
          setup,
          // A coding plan also needs to know whether that computer takes a plan's key.
          brain: view && (ai.data || !isPlanId(choice)) ? view : undefined,
          computer: row,
        });
  // A poll that fails once keeps the last view: a sign-in in progress goes on.
  return { gateOf, view, failed: brain.isError && !view, edition, waited, markWaited, catching };
}

export type PlanGates = ReturnType<typeof usePlanGates>;

/** Where the flow is: the first page, the coding plans, one plan's page, or the API key's. */
export type FlowView = { page: "home" } | { page: "coding" } | { page: "plan"; choice: PlanChoice } | { page: "key" };

/** The page an intent opens on (a message that asked for a plan or a key). */
export const viewOf = (choice: AiChoice | null): FlowView =>
  !choice ? { page: "home" } : choice === "key" ? { page: "key" } : { page: "plan", choice };

const CODING_MARKS = ["zai", "kimi", "minimax", "opencode"] as const;

export interface ConnectAiFlowProps {
  view: FlowView;
  onView: (view: FlowView) => void;
  /** The person's agents a plan may think for, in the order offered. */
  agents: { id: string; name: string }[];
  /** Whether an agent already thinks with something (a plan starts on the first one without). */
  hasAi: (agentId: string) => boolean;
  /** The agent to start on (a card that names one). */
  startAgentId?: string;
  /** Why this person connects no plan here (someone else's agent, none of their own). */
  locked?: ReactNode;
  /** Only an admin adds an API key. */
  mayAddKey: boolean;
  /** The key being typed and its save (`useConnectKey`). */
  keyForm: ConnectKey;
  /** The key page saves with its own button; without it the caller does (the first run's button). */
  keyButton?: boolean;
  keySaved?: boolean;
  onSaveKey?: () => void;
  /** The person came because the computer just got ready: said first, once it is. */
  justReady?: boolean;
  /** Self-host with no computer for the agent: where one is connected. */
  onComputer: () => void;
  /** The agent thinks with the plan now. */
  onPlanDone: (agentId: string) => void;
  /** A sheet: its own head (close on the first page, back on the others). Inline (the first run): a back row. */
  sheetTitle?: string;
}

/**
 * The whole flow: its head and the page it is on. The agent a plan is for and what each plan can do for it live
 * here, above the pages: the first page dims a plan that can't sign in there, and a plan's page that waited for the
 * computer says it's ready when it shows again.
 */
export function ConnectAiFlow(props: ConnectAiFlowProps) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const { orgId } = useAiOrg();
  const { view, onView, sheetTitle, agents, hasAi, startAgentId, locked } = props;
  // Only a pick is kept; else the first agent is worked out on each render (the agents may load after this opens).
  const [pickedAgent, setPickedAgent] = useState<string>();
  const agentId = locked ? undefined : (pickedAgent ?? firstAgent(agents, hasAi, startAgentId)?.id);
  const [polls, setPolls] = useState(false);
  const gates = usePlanGates(orgId, agentId, polls ? PLAN_POLL_MS : false);
  const shown = gates.gateOf(view.page === "plan" ? view.choice : "claude").state;
  useEffect(() => setPolls(agentId !== undefined && pollsPlan(shown)), [agentId, shown]);
  const { markWaited } = gates;
  const onPlan = view.page === "plan";
  useEffect(() => {
    if (onPlan && shown === "preparing") markWaited();
  }, [onPlan, shown, markWaited]);
  const dims = (choice: PlanChoice) => agentId !== undefined && gateDims(gates.gateOf(choice));
  const go = (next: FlowView) => {
    // Another plan moves on to the next agent with no AI once this one thinks with a plan from here.
    if (next.page === "plan" && pickedAgent !== undefined && hasAi(pickedAgent)) setPickedAgent(undefined);
    onView(next);
  };
  const to: FlowView | null =
    view.page === "home" ? null : view.page === "plan" && isPlanId(view.choice) ? { page: "coding" } : { page: "home" };
  const title =
    view.page === "home"
      ? (sheetTitle ?? t("connectAi.title.any"))
      : view.page === "coding"
        ? t("mobile.ai.coding")
        : view.page === "key"
          ? t("connectAi.key.title")
          : planLabel(t, view.choice);
  return (
    <>
      {sheetTitle !== undefined ? (
        <SheetHeader title={title} icon={to ? "back" : "x"} {...(to ? { onPress: () => go(to) } : {})} />
      ) : to ? (
        <Pressable onPress={() => go(to)} accessibilityRole="button" style={styles.backRow} hitSlop={8}>
          <Icon name="back" size={16} color={c.muted} />
          <Text variant="subhead" tone="muted" style={styles.bold}>
            {t("mobile.common.back")}
          </Text>
        </Pressable>
      ) : null}
      {view.page === "home" ? (
        <Home onView={go} dims={dims} />
      ) : view.page === "coding" ? (
        <Coding onView={go} dims={dims} />
      ) : view.page === "plan" ? (
        <PlanPage
          key={view.choice}
          {...props}
          onView={go}
          choice={view.choice}
          gates={gates}
          agentId={agentId}
          onAgent={setPickedAgent}
        />
      ) : (
        <KeyPage {...props} />
      )}
    </>
  );
}

/** The first page: your AI plan, then pay as you go. A plan that can't sign in on the agent's computer is dimmed. */
function Home({ onView, dims }: { onView: (v: FlowView) => void; dims: (choice: PlanChoice) => boolean }) {
  const { t } = useTranslation();
  return (
    <View>
      <GroupedHeader>{t("mobile.ai.yourPlan")}</GroupedHeader>
      <GroupedList>
        {(["claude", "chatgpt"] as const).map((c) => (
          <GroupedRow
            key={c}
            leading={<ProviderLogo id={planMark(c)} size="sm" off={dims(c)} />}
            label={planLabel(t, c)}
            sub={t(`connectAi.plan.${c}.tiers`)}
            chevron
            onPress={() => onView({ page: "plan", choice: c })}
          />
        ))}
        <GroupedRow
          leading={<ProviderQuad ids={CODING_MARKS} off={PLAN_IDS.every(dims)} />}
          label={t("mobile.ai.coding")}
          sub={t("mobile.ai.codingSub")}
          chevron
          onPress={() => onView({ page: "coding" })}
        />
      </GroupedList>
      <GroupedFooter>{t("mobile.ai.plansFoot")}</GroupedFooter>
      <GroupedHeader>{t("connectAi.orPayGo")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          leading={<ProviderQuad ids={KEY_MARKS} />}
          label={t("connectAi.key.title")}
          sub={t("connectAi.key.makers")}
          subLines={2}
          chevron
          onPress={() => onView({ page: "key" })}
        />
      </GroupedList>
    </View>
  );
}

/** The four coding plans. */
function Coding({ onView, dims }: { onView: (v: FlowView) => void; dims: (choice: PlanChoice) => boolean }) {
  const { t } = useTranslation();
  return (
    <View>
      <GroupedHeader>{t("mobile.ai.whichPlan")}</GroupedHeader>
      <GroupedList>
        {PLAN_IDS.map((c) => (
          <GroupedRow
            key={c}
            leading={<ProviderLogo id={planMark(c)} size="sm" off={dims(c)} />}
            label={planLabel(t, c)}
            sub={t(`connectAi.plan.${c}.tiers`)}
            chevron
            onPress={() => onView({ page: "plan", choice: c })}
          />
        ))}
      </GroupedList>
      <GroupedFooter>{t("mobile.ai.codingFoot")}</GroupedFooter>
    </View>
  );
}

/** A page's head: the option's mark, big, its name and what it covers. */
function Hero({ mark, title, sub }: { mark: ReactNode; title: string; sub: string }) {
  return (
    <View style={styles.hero}>
      {mark}
      <Text variant="title2" tone="ink" style={styles.center} accessibilityRole="header">
        {title}
      </Text>
      <Text variant="subhead" tone="muted" style={styles.center}>
        {sub}
      </Text>
    </View>
  );
}

/** A line in a white card (why the steps wait), with its action. */
function InfoCard({ icon, children, action }: { icon: IconName; children: ReactNode; action?: ReactNode }) {
  const { colors: c, shadows } = useTheme();
  return (
    <View style={[styles.info, { backgroundColor: c.raised, boxShadow: `${shadows.e1}, ${shadows.top}` }]}>
      <Icon name={icon} size={18} color={c.ink2} />
      <Text variant="subhead" tone="muted">
        {children}
      </Text>
      {action ? <View style={styles.start}>{action}</View> : null}
    </View>
  );
}

/** One plan's page: its mark, for which agent, then its steps on the agent's computer. */
function PlanPage(
  props: ConnectAiFlowProps & {
    choice: PlanChoice;
    gates: PlanGates;
    agentId: string | undefined;
    onAgent: (id: string) => void;
  },
) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const { choice, agents, locked, onView, gates, agentId, onAgent } = props;
  const agent = agents.find((a) => a.id === agentId);
  const [done, setDone] = useState<{ agentId: string; agent: string; label: string } | null>(null);
  const pick = () => {
    const names = agents.map((a) => a.name);
    const choose = (i: number) => {
      const a = agents[i];
      if (a) onAgent(a.id);
    };
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { title: t("connectAi.agent"), options: [...names, t("common.cancel")], cancelButtonIndex: names.length },
        choose,
      );
    } else {
      Alert.alert(t("connectAi.agent"), undefined, [
        ...agents.map((a, i) => ({ text: a.name, onPress: () => choose(i) })),
        { text: t("common.cancel"), style: "cancel" as const },
      ]);
    }
  };
  if (done) {
    return (
      <View style={styles.done}>
        <AgentFace agentId={done.agentId} size={64} live={false} />
        <Text variant="title2" tone="ink" style={styles.center}>
          {t("aiAccounts.done.savedAgent", { agent: done.agent, label: done.label })}
        </Text>
        <Text variant="subhead" tone="muted" style={styles.center}>
          {t("connectAi.own.note")}
        </Text>
      </View>
    );
  }
  return (
    <View>
      <Hero
        mark={<ProviderLogo id={planMark(choice)} size="hero" />}
        title={planTitle(t, choice)}
        sub={t(`connectAi.plan.${choice}.tiers`)}
      />
      {locked ? (
        <Note icon="lock">{locked}</Note>
      ) : agent ? (
        <>
          <GroupedHeader>{t("connectAi.agent")}</GroupedHeader>
          <GroupedList>
            <GroupedRow
              leading={<AgentFace agentId={agent.id} size={30} live={false} />}
              label={agent.name}
              {...(agents.length > 1 ? { value: t("mobile.ai.change"), chevron: true, onPress: pick } : {})}
            />
          </GroupedList>
          <GroupedHeader>{t("mobile.ai.how")}</GroupedHeader>
          <PlanSteps
            key={agent.id}
            choice={choice}
            gates={gates}
            agentId={agent.id}
            agentName={agent.name}
            justReady={props.justReady}
            onComputer={props.onComputer}
            onKey={() => onView({ page: "key" })}
            onDone={(account) => {
              // The flow stays on that agent; another plan moves on to the next one with no AI.
              onAgent(agent.id);
              setDone({ agentId: agent.id, agent: agent.name, label: account?.label ?? planLabel(t, choice) });
              props.onPlanDone(agent.id);
            }}
          />
        </>
      ) : (
        <ActivityIndicator color={c.muted} style={styles.loading} />
      )}
    </View>
  );
}

function PlanSteps({
  choice,
  gates,
  agentId,
  agentName,
  justReady,
  onKey,
  onComputer,
  onDone,
}: {
  choice: PlanChoice;
  gates: PlanGates;
  agentId: string;
  agentName: string;
  justReady?: boolean;
  onKey: () => void;
  onComputer: () => void;
  onDone: (account: MachineAccount | null) => void;
}) {
  const { t } = useTranslation();
  const { orgId, org } = useAiOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const { colors: c } = useTheme();
  const { view, edition } = gates;
  const gate = gates.gateOf(choice);
  const machines = useMachines(orgId, edition !== null);
  const kind = kindOf(choice);
  const coding = isPlanId(choice);
  const [failedAccount, setFailedAccount] = useState<MachineAccount | null>(null);
  const [saving, setSaving] = useState(false);
  const [other, setOther] = useState(false);
  // It turned ready while the person watched (here or on another plan's page), or they came because it did.
  const waited = gates.waited || justReady === true;

  const managed = machines.data?.find((m) => m.kind === "managed");
  const computer = edition === "cloud" ? computerName(t, org?.name ?? "", managed) : (view?.computer?.name ?? "");
  const refresh = () => {
    for (const key of [
      keys.agentBrain(orgId, agentId),
      keys.agents(orgId),
      keys.machines(orgId),
      keys.aiAccounts(orgId),
      keys.aiStatus(orgId),
    ])
      void qc.invalidateQueries({ queryKey: key });
  };
  // The sign-in ended: the agent thinks with that account right away (no confirming tap).
  const assign = async (a: MachineAccount) => {
    setSaving(true);
    setFailedAccount(null);
    try {
      await api.agents.setBrain(orgId, agentId, { brain: a.kind, account: a.id });
      refresh();
      onDone(a);
    } catch {
      setFailedAccount(a);
    } finally {
      setSaving(false);
    }
  };
  const saveOwn = async () => {
    try {
      await api.agents.setBrain(orgId, agentId, { brain: kind, account: null });
      refresh();
      onDone(null);
    } catch {
      toast({ title: t("agentPage.work.failed"), icon: "x" });
    }
  };

  if (gates.failed) return <InfoCard icon="x">{t("common.loadFailed")}</InfoCard>;
  if (saving) return <ActivityIndicator color={c.muted} style={styles.loading} />;
  if (failedAccount) {
    return (
      <InfoCard
        icon="x"
        action={
          <Button size="sm" variant="secondary" label={t("common.retry")} onPress={() => void assign(failedAccount)} />
        }
      >
        {t("connectAi.assignFailed", { label: failedAccount.label, agent: agentName })}
      </InfoCard>
    );
  }

  const ready = gate.state === "ready";
  const useKey = <Button variant="ghost" wide label={t("connectAi.wait.useKey")} onPress={onKey} />;
  const hold = holdText(t, org?.standing);
  let wait: ReactNode = null;
  if (gate.state === "loading") wait = <ActivityIndicator color={c.muted} style={styles.loading} />;
  else if (gate.state === "preparing") {
    const setup = gate.view;
    // A hold decides when anything runs there: it speaks alone. The wait is the app's own (its steps, the time left,
    // who hears when it's ready), for the workspace these pages connect for: the first run's too.
    wait = hold ? (
      <InfoCard icon="pause">{hold}</InfoCard>
    ) : (
      <View style={styles.gap}>
        {setup ? <SetupWait view={setup} workspace={{ orgId, name: org?.name ?? "" }} /> : null}
        <InfoCard icon="clock">{t(coding ? "connectAi.wait.key" : "connectAi.wait.signIn")}</InfoCard>
      </View>
    );
  } else if (gate.state === "offline") {
    wait = (
      <InfoCard icon="laptop">
        {edition === "cloud"
          ? t("aiAccounts.connect.needsCloud.online", { computer })
          : t("brain.offline", { computer })}
      </InfoCard>
    );
  } else if (gate.state === "missing") {
    wait = (
      <>
        <InfoCard
          icon="laptop"
          action={
            <Button size="sm" variant="primary" label={t("aiAccounts.connect.addComputer")} onPress={onComputer} />
          }
        >
          {t("aiAccounts.connect.noComputer")}
        </InfoCard>
        <Note icon="lock">{t("mobile.ai.meanwhile")}</Note>
      </>
    );
  } else if (gate.state === "unsupported") {
    wait = (
      <InfoCard icon="laptop">
        {edition === "cloud"
          ? t(`aiAccounts.connect.needsCloud.${kind}`, { computer })
          : gate.reason === "keys"
            ? t("aiAccounts.connect.needs.keys")
            : t(`brain.reasons.${gate.reason}`, { computer })}
      </InfoCard>
    );
  } else if (gate.state === "locked") {
    const pairer = machines.data?.find((m) => m.id === view?.computer?.machineId)?.pairedBy?.name.split(" ")[0];
    wait = (
      <InfoCard icon="lock">
        {gate.who === "computer"
          ? t("connectAi.accountsLocked", { name: pairer ?? "", computer })
          : t("noAi.lockedAdmins")}
      </InfoCard>
    );
  }

  // The steps stay in view while they wait (their computer actions off); a reason alone otherwise.
  const steps = ready || gate.state === "preparing";
  const ownable = ready && !coding && view?.ownSignIn === true;
  const brand = planLabel(t, choice);
  const current = view?.accounts.find(
    (a) => a.id === view.account && a.kind === kind && (coding ? a.provider === choice : !a.provider),
  );
  const signedOut = current?.status === "signed_out" ? current : undefined;
  return (
    <View style={styles.gap}>
      {wait}
      {offersKeyNow(gate, hold !== null) ? useKey : null}
      {ready && waited ? (
        <Note icon="check" live>
          {t("connectAi.wait.ready", { computer })}
        </Note>
      ) : null}
      {ownable ? (
        <>
          <GroupedList>
            <GroupedRow
              label={t("connectAi.own.this", { brand, computer })}
              sub={t("connectAi.own.thisText")}
              subLines={2}
              onPress={() => void saveOwn()}
            />
            <GroupedRow label={t("connectAi.own.other", { brand })} checked={other} onPress={() => setOther(true)} />
          </GroupedList>
          <Note icon="lock">{t("connectAi.own.note")}</Note>
        </>
      ) : null}
      {steps && (!ownable || other) ? (
        <AddAccount
          machineId={view?.computer?.machineId ?? ""}
          kind={kind}
          computer={computer}
          {...(isPlanId(choice) ? { provider: choice } : {})}
          again={signedOut?.id}
          email={signedOut?.email}
          askEmail={view?.ownSignIn || view?.accounts.some((a) => a.mine && a.kind === kind && !a.provider)}
          local={view?.ownSignIn}
          ready={ready}
          loading={gates.catching}
          note={!coding ? <Note icon="lock">{t("connectAi.onlyYou", agentGrammar(t, agentName))}</Note> : null}
          onAdded={(a) => void assign(a)}
        />
      ) : null}
    </View>
  );
}

/**
 * The API key's page: whose key (a radio list; paid per use, straight to its maker), then the web's two numbered
 * steps: create the key on the maker's page, paste it here. Saved by its button.
 */
function KeyPage({ mayAddKey, keyForm: form, keyButton = true, keySaved, onSaveKey }: ConnectAiFlowProps) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const [touched, setTouched] = useState(false);
  const [opened, setOpened] = useState(false);
  const maker = providerOf(form.provider);
  const hint = maker && keyStepHint(maker);
  const clean = form.key.trim();
  const valid = keyLooksValid(form.provider, clean);
  const wrong = touched && clean.length > 0 && !valid;
  const others = wrong ? providersForKey(clean) : [];
  if (!mayAddKey) return <InfoCard icon="lock">{t("connectAi.keyLocked")}</InfoCard>;
  if (keySaved) {
    return (
      <View style={styles.done}>
        <ProviderLogo id={form.provider} size="hero" />
        <Text variant="title2" tone="ink" style={styles.center}>
          {t("connectAi.key.saved")}
        </Text>
      </View>
    );
  }
  const site = maker ? new URL(`https://${maker.site}`) : null;
  return (
    <View>
      <GroupedHeader>{t("mobile.ai.whose")}</GroupedHeader>
      <GroupedList>
        {PROVIDERS.map((p) => (
          <GroupedRow
            key={p.id}
            leading={<ProviderLogo id={p.id} size="sm" />}
            label={p.label}
            checked={form.provider === p.id}
            onPress={() => form.setProvider(p.id)}
          />
        ))}
      </GroupedList>
      <GroupedFooter>{t("connectAi.key.sub")}</GroupedFooter>
      {maker && site ? (
        <View style={styles.keySteps}>
          <StepsCard>
            <Step
              n={1}
              state={opened || clean ? "done" : "now"}
              title={t("connectAi.key.create", providerGrammar(t, form.provider))}
              hint={hint && t(hint)}
              side={
                <OpenPage
                  href={site.href}
                  primary={!clean}
                  label={t("aiAccounts.add.openKeys", { site: site.host })}
                  onOpened={() => setOpened(true)}
                />
              }
            />
            <Step n={2} divider title={t("connectAi.key.paste")}>
              <PasteField
                value={form.key}
                onChangeText={form.setKey}
                onPasted={form.setKey}
                onBlur={() => setTouched(true)}
                label={t("connectAi.key.paste")}
                placeholder={maker.placeholder}
                secret
                onSubmit={() => {
                  setTouched(true);
                  if (valid && keyButton) onSaveKey?.();
                }}
              />
              {wrong ? (
                <View style={styles.others}>
                  <Text variant="small" tone="danger" accessibilityLiveRegion="polite">
                    {t(`onboarding.keyInvalid.${form.provider}`)}
                  </Text>
                  {others.length > 0 ? (
                    <>
                      <Text variant="small" tone="faint">
                        {t("onboarding.keyFromOther")}
                      </Text>
                      {others.map((p) => (
                        <Pressable
                          key={p.id}
                          onPress={() => form.setProvider(p.id)}
                          accessibilityRole="button"
                          style={[styles.other, { backgroundColor: c.chip }]}
                        >
                          <ProviderLogo id={p.id} size="xs" />
                          <Text variant="footnote" tone="ink" style={styles.bold}>
                            {p.label}
                          </Text>
                        </Pressable>
                      ))}
                    </>
                  ) : null}
                </View>
              ) : null}
            </Step>
          </StepsCard>
          {form.failed ? (
            <Note icon="x" live>
              {t("mobile.ai.failed")}
            </Note>
          ) : (
            <Note icon="info">{t("connectAi.key.forAll")}</Note>
          )}
          {keyButton ? (
            <View style={styles.save}>
              <Button
                variant="primary"
                wide
                label={form.saving ? t("mobile.ai.saving") : t("mobile.ai.save")}
                disabled={!valid || form.saving}
                onPress={() => onSaveKey?.()}
              />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bold: { fontWeight: "600" },
  center: { textAlign: "center" },
  start: { alignSelf: "flex-start" },
  gap: { gap: 10 },
  loading: { marginTop: 16 },
  backRow: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", marginBottom: 4 },
  hero: { alignItems: "center", gap: 8, paddingTop: 6, paddingBottom: 4 },
  done: { alignItems: "center", gap: 12, paddingVertical: 28, paddingHorizontal: 10 },
  info: { borderRadius: 14, padding: 14, gap: 10 },
  keySteps: { marginTop: 16, gap: 10 },
  others: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 6 },
  other: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 30,
    paddingHorizontal: 10,
    borderRadius: 999,
  },
  save: { marginTop: 6 },
});
