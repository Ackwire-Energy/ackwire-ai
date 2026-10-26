import type { MachineAccount } from "@agenteschat/client";
import { keys, useAgentBrain, useAiAccounts, useApi, useComputerSetup, useMachines } from "@agenteschat/client";
import { computerEdition, computerName, setupView } from "@agenteschat/client/lib/computer";
import { holdText } from "@agenteschat/client/lib/errors";
import { agentGrammar, providerGrammar } from "@agenteschat/client/lib/grammar";
import {
  type AiChoice,
  KEY_MARKS,
  kindOf,
  PLAN_CHOICES,
  type PlanChoice,
  type PlanGate,
  planGate,
  planLabel,
  planMark,
  planTitle,
} from "@agenteschat/client/lib/no-ai";
import { isPlanId } from "@agenteschat/client/lib/plans";
import {
  keyLooksValid,
  PROVIDERS,
  type ProviderId,
  providerOf,
  providersForKey,
} from "@agenteschat/client/lib/providers";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { Button, fieldText, Icon, OptionTile, ProviderLogo, ProviderStack, Text, useTheme, useToast } from "@/ui";
import { SetupWait } from "../computer/SetupWait";
import { AddAccount } from "./AddAccount";
import { useAiOrg, useInWorkspace } from "./org";
import { Note, OpenPage, Step } from "./parts";

/*
 * One picker wherever an AI is connected, as on the web (`ConnectAiSteps.tsx`): the six plans first, by their
 * makers' marks, then one API key row; the chosen option's panel right under it. A plan signs in on the agent's
 * computer (ADR 0059): while the workspace's computer is on its way, its panel waits in place and turns on by
 * itself, with what needs no computer (a maker's page, a key to paste) on meanwhile.
 */

/** What each plan can do now for one agent (`planGate`), from its brain view, its computer's row and the setup. */
export function usePlanGates(orgId: string, agentId: string | undefined, poll: number | false = false) {
  const brain = useAgentBrain(orgId, agentId ?? "", agentId !== undefined, poll);
  const ai = useAiAccounts(orgId, agentId !== undefined, poll);
  const setupQ = useComputerSetup(orgId);
  const edition = computerEdition(setupQ.data);
  const setup = setupView(setupQ.data, setupQ.dataUpdatedAt);
  const view = brain.data;
  const row = ai.data?.computers.find((c) => c.machineId === view?.computer?.machineId);
  const gateOf = (choice: PlanChoice): PlanGate =>
    planGate({
      choice,
      edition,
      setup,
      // A coding plan also needs to know whether that computer takes a plan's key.
      brain: view && (ai.data || !isPlanId(choice)) ? view : undefined,
      computer: row,
    });
  // A poll that fails once keeps the last view: a sign-in in progress goes on.
  return { gateOf, view, failed: brain.isError && !view, edition };
}

export type PlanGates = ReturnType<typeof usePlanGates>;

/** Two tiles a row (the web's grid at phone width). */
function Grid({ children }: { children: ReactNode }) {
  return <View style={styles.grid}>{children}</View>;
}

/** The six plans as tiles (one dims where it can't sign in; it still opens its panel), then the API key row. */
export function AiPicker({
  choice,
  onPick,
  dims,
}: {
  choice: AiChoice;
  onPick: (choice: AiChoice) => void;
  dims?: (choice: PlanChoice) => boolean;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.picker} accessibilityLabel={t("onboarding.keyStep.title")}>
      <Grid>
        {PLAN_CHOICES.map((c) => (
          <OptionTile
            key={c}
            pressed={choice === c}
            stepBack
            label={planLabel(t, c)}
            onPress={() => onPick(c)}
            style={styles.cell}
          >
            <View style={styles.tile}>
              <ProviderLogo id={planMark(c)} size="sm" off={dims?.(c)} />
              <Text
                variant="subhead"
                tone="ink"
                numberOfLines={1}
                style={[styles.tileTitle, choice === c && styles.room]}
              >
                {planLabel(t, c)}
              </Text>
            </View>
          </OptionTile>
        ))}
      </Grid>
      <Text variant="small" tone="muted" style={styles.or}>
        {t("connectAi.orPayGo")}
      </Text>
      <OptionTile pressed={choice === "key"} stepBack label={t("connectAi.key.title")} onPress={() => onPick("key")}>
        <View style={styles.keyRow}>
          <ProviderStack ids={KEY_MARKS} />
          <View style={[styles.grow, choice === "key" && styles.room]}>
            <Text variant="subhead" tone="ink" style={styles.bold}>
              {t("connectAi.key.title")}
            </Text>
            <Text variant="small" tone="muted">
              {t("connectAi.key.makers")}
            </Text>
          </View>
        </View>
      </OptionTile>
    </View>
  );
}

/** A panel's card: its head (the option's lead on its name's line, what it covers), a hairline, then its body. */
function Panel({
  lead,
  title,
  sub,
  aside,
  children,
}: {
  lead: ReactNode;
  title: string;
  sub: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const { colors: c, shadows } = useTheme();
  return (
    <View
      accessibilityLabel={title}
      style={[styles.panel, { backgroundColor: c.raised, boxShadow: `${shadows.e1}, ${shadows.top}` }]}
    >
      <View style={[styles.head, { borderBottomColor: c.line }]}>
        {lead}
        <View style={styles.grow}>
          <Text variant="callout" tone="ink" style={styles.heavy}>
            {title}
          </Text>
          <Text variant="small" tone="muted">
            {sub}
          </Text>
        </View>
      </View>
      {aside}
      {children}
    </View>
  );
}

/** The agent a plan thinks for (the web's select): its name, tapped to pick another. */
function AgentPicker({
  agents,
  agentId,
  onAgent,
}: {
  agents: { id: string; name: string }[];
  agentId: string;
  onAgent: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const agent = agents.find((a) => a.id === agentId);
  const pick = () => {
    const names = agents.map((a) => a.name);
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { title: t("connectAi.agent"), options: [...names, t("common.cancel")], cancelButtonIndex: names.length },
        (i) => {
          const a = agents[i];
          if (a) onAgent(a.id);
        },
      );
    } else {
      Alert.alert(t("connectAi.agent"), undefined, [
        ...agents.map((a) => ({ text: a.name, onPress: () => onAgent(a.id) })),
        { text: t("common.cancel"), style: "cancel" as const },
      ]);
    }
  };
  return (
    <Pressable
      onPress={pick}
      accessibilityRole="button"
      accessibilityLabel={`${t("connectAi.agent")}: ${agent?.name ?? ""}`}
      style={[styles.agent, { backgroundColor: c.chip }]}
    >
      <Text variant="small" tone="muted">
        {t("connectAi.agent")}
      </Text>
      <Text variant="small" tone="ink" style={styles.bold}>
        {agent?.name}
      </Text>
      <Icon name="chev" size={12} color={c.muted} />
    </Pressable>
  );
}

export interface PlanPanelProps {
  choice: PlanChoice;
  gates: PlanGates;
  /** The person's agents a plan may think for, in the order offered; the picker shows with more than one. */
  agents: { id: string; name: string }[];
  agentId: string | undefined;
  onAgent: (id: string) => void;
  /** Why this person connects no plan here (an agent of someone else's, no agent of their own): nothing else shows. */
  locked?: ReactNode;
  /** The person came because the computer just got ready: said first, once it is. */
  justReady?: boolean;
  /** "Usar uma chave de API agora": the API key row. */
  onKey: () => void;
  /** Self-host with no computer for the agent: where one is connected. */
  onComputer: () => void;
  /** The agent thinks with the plan now: the account it signed in (null: the computer's own sign-in). */
  onDone: (agentId: string, account: MachineAccount | null) => void;
}

/** A plan's panel: what it covers and for which agent, then its steps, or what they wait for. */
export function PlanPanel(props: PlanPanelProps) {
  const { t } = useTranslation();
  const { choice, agents, agentId, onAgent, locked } = props;
  const { colors: c } = useTheme();
  const title = planTitle(t, choice);
  const agent = agents.find((a) => a.id === agentId);
  return (
    <Panel
      lead={<ProviderLogo id={planMark(choice)} size="sm" />}
      title={title}
      sub={t(`connectAi.plan.${choice}.tiers`)}
      aside={
        agents.length > 1 && agent ? <AgentPicker agents={agents} agentId={agent.id} onAgent={onAgent} /> : undefined
      }
    >
      {locked ? (
        <Note icon="lock">{locked}</Note>
      ) : agent ? (
        <PlanSteps key={agent.id} {...props} agentId={agent.id} agentName={agent.name} />
      ) : (
        <ActivityIndicator color={c.muted} />
      )}
    </Panel>
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
}: PlanPanelProps & { agentId: string; agentName: string }) {
  const { t } = useTranslation();
  const { orgId, org } = useAiOrg();
  // The computer's wait reads the chosen workspace: the first run says the plain line instead.
  const inWorkspace = useInWorkspace();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const { colors: c } = useTheme();
  const { view, edition } = gates;
  const gate = gates.gateOf(choice);
  const machines = useMachines(orgId, edition !== null);
  const kind = kindOf(choice);
  const coding = isPlanId(choice);
  const [account, setAccount] = useState<MachineAccount | null>(null);
  const [assigned, setAssigned] = useState<"saving" | "failed" | "done">("saving");
  const [other, setOther] = useState(false);
  const [ownSaved, setOwnSaved] = useState(false);
  // It turns ready while the person watches, or they came because it did: said once, in place.
  const [waited, setWaited] = useState(gate.state === "preparing" || justReady === true);
  useEffect(() => {
    if (gate.state === "preparing") setWaited(true);
  }, [gate.state]);

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
    setAccount(a);
    setAssigned("saving");
    try {
      await api.agents.setBrain(orgId, agentId, { brain: a.kind, account: a.id });
      setAssigned("done");
      refresh();
      onDone(agentId, a);
    } catch {
      setAssigned("failed");
    }
  };
  const saveOwn = async () => {
    try {
      await api.agents.setBrain(orgId, agentId, { brain: kind, account: null });
      setOwnSaved(true);
      refresh();
      onDone(agentId, null);
    } catch {
      toast({ title: t("agentPage.work.failed"), icon: "x" });
    }
  };

  if (gates.failed) return <Note icon="x">{t("common.loadFailed")}</Note>;
  if (account) {
    if (assigned === "saving") return <ActivityIndicator color={c.muted} />;
    return assigned === "done" ? (
      <Note icon="check" live>
        {t("aiAccounts.done.savedAgent", { agent: agentName, label: account.label })}
      </Note>
    ) : (
      <View style={styles.rowGap}>
        <Note icon="x" live>
          {t("connectAi.assignFailed", { label: account.label, agent: agentName })}
        </Note>
        <Button size="sm" variant="secondary" label={t("common.retry")} onPress={() => void assign(account)} />
      </View>
    );
  }
  if (ownSaved) {
    return (
      <Note icon="check" live>
        {t("agentPage.work.saved.accountHere", { name: agentName, computer })}
      </Note>
    );
  }

  const ready = gate.state === "ready";
  const useKey = (
    <View style={styles.start}>
      <Button size="sm" variant="secondary" label={t("connectAi.wait.useKey")} onPress={onKey} />
    </View>
  );
  const hold = holdText(t, org?.standing);
  let wait: ReactNode = null;
  if (gate.state === "loading") wait = <ActivityIndicator color={c.muted} style={styles.start} />;
  else if (gate.state === "preparing") {
    const setup = gate.view;
    const later = t(coding ? "connectAi.wait.key" : "connectAi.wait.signIn");
    // A hold decides when anything runs there: it speaks alone.
    wait = hold ? (
      <Note icon="pause">{hold}</Note>
    ) : (
      <View style={styles.rowGap}>
        {setup && inWorkspace ? <SetupWait view={setup} agentName={agentName} /> : null}
        {setup && !inWorkspace ? <Note icon="laptop">{t(setup.textKey)}</Note> : null}
        <Note icon="clock">{later}</Note>
        {setup?.phase === "waiting" || setup?.phase === "problem" ? useKey : null}
      </View>
    );
  } else if (gate.state === "offline") {
    wait = (
      <View style={styles.rowGap}>
        <Note icon="x">
          {edition === "cloud"
            ? t("aiAccounts.connect.needsCloud.online", { computer })
            : t("brain.offline", { computer })}
        </Note>
        {useKey}
      </View>
    );
  } else if (gate.state === "missing") {
    wait = (
      <View style={styles.rowGap}>
        <Note icon="laptop">{t("aiAccounts.connect.noComputer")}</Note>
        <View style={styles.start}>
          <Button size="sm" variant="primary" label={t("aiAccounts.connect.addComputer")} onPress={onComputer} />
        </View>
      </View>
    );
  } else if (gate.state === "unsupported") {
    wait = (
      <View style={styles.rowGap}>
        <Note icon="x">
          {edition === "cloud"
            ? t(`aiAccounts.connect.needsCloud.${kind}`, { computer })
            : gate.reason === "keys"
              ? t("aiAccounts.connect.needs.keys")
              : t(`brain.reasons.${gate.reason}`, { computer })}
        </Note>
        {useKey}
      </View>
    );
  } else if (gate.state === "locked") {
    const pairer = machines.data?.find((m) => m.id === view?.computer?.machineId)?.pairedBy?.name.split(" ")[0];
    wait = (
      <Note icon="lock">
        {gate.who === "computer"
          ? t("connectAi.accountsLocked", { name: pairer ?? "", computer })
          : t("noAi.lockedAdmins")}
      </Note>
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
    <>
      {wait}
      {ready && waited ? (
        <Note icon="check" live>
          {t("connectAi.wait.ready", { computer })}
        </Note>
      ) : null}
      {ownable ? (
        <>
          <View style={styles.rowGap}>
            <OptionTile
              pressed={false}
              label={t("connectAi.own.this", { brand, computer })}
              onPress={() => void saveOwn()}
            >
              <Text variant="subhead" tone="ink" style={styles.bold}>
                {t("connectAi.own.this", { brand, computer })}
              </Text>
              <Text variant="small" tone="muted">
                {t("connectAi.own.thisText")}
              </Text>
            </OptionTile>
            <OptionTile pressed={other} label={t("connectAi.own.other", { brand })} onPress={() => setOther(true)}>
              <Text variant="subhead" tone="ink" style={[styles.bold, other && styles.room]}>
                {t("connectAi.own.other", { brand })}
              </Text>
              <Text variant="small" tone="muted">
                {t("connectAi.own.otherText", { computer })}
              </Text>
            </OptionTile>
          </View>
          <Note icon="lock">{t("connectAi.own.note")}</Note>
        </>
      ) : null}
      {steps && (!ownable || other) ? (
        <View style={wait || ownable ? [styles.after, { borderTopColor: c.line }] : undefined}>
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
            note={!coding ? <Note icon="lock">{t("aiAccounts.share.on", agentGrammar(t, agentName))}</Note> : null}
            onAdded={(a) => void assign(a)}
          />
        </View>
      ) : null}
    </>
  );
}

/** The API key being added: its maker and the key. */
export interface KeyDraft {
  provider: ProviderId;
  apiKey: string;
}

/**
 * The API key, as the web's panel: its maker, by its mark; where that maker's keys are made; then the key, pasted
 * here and saved with its own button.
 */
export function KeyPanel({
  draft,
  onDraft,
  locked,
  saved,
  saving,
  failed,
  onSave,
}: {
  draft: KeyDraft;
  onDraft: (draft: KeyDraft) => void;
  /** Only an admin adds an API key. */
  locked?: boolean;
  saved?: boolean;
  saving?: boolean;
  failed?: boolean;
  /** Saved with its own button; without it, the caller saves (the first run's button). */
  onSave?: () => void;
}) {
  const { t } = useTranslation();
  const { colors: c, shadows } = useTheme();
  const [touched, setTouched] = useState(false);
  const { provider, apiKey } = draft;
  const maker = providerOf(provider);
  const valid = keyLooksValid(provider, apiKey);
  const wrong = touched && apiKey.trim().length > 0 && !valid;
  const site = maker ? new URL(`https://${maker.site}`) : null;
  const pick = (next: ProviderId) => onDraft({ provider: next, apiKey });
  const others = wrong ? providersForKey(apiKey) : [];
  return (
    <Panel lead={<ProviderStack ids={KEY_MARKS} />} title={t("connectAi.key.title")} sub={t("connectAi.key.sub")}>
      {locked ? (
        <Note icon="lock">{t("connectAi.keyLocked")}</Note>
      ) : saved ? (
        <Note icon="check" live>
          {t("connectAi.key.saved")}
        </Note>
      ) : (
        <>
          <Grid>
            {PROVIDERS.map((p) => (
              <OptionTile
                key={p.id}
                pressed={provider === p.id}
                stepBack
                label={p.label}
                onPress={() => pick(p.id)}
                style={styles.cell}
              >
                <View style={styles.tile}>
                  <ProviderLogo id={p.id} size="sm" />
                  <Text
                    variant="subhead"
                    tone="ink"
                    numberOfLines={1}
                    style={[styles.tileTitle, provider === p.id && styles.room]}
                  >
                    {p.label}
                  </Text>
                </View>
              </OptionTile>
            ))}
          </Grid>
          {maker && site ? (
            <>
              <Step
                n={1}
                title={t("connectAi.key.create", providerGrammar(t, provider))}
                side={
                  <OpenPage
                    href={site.href}
                    primary={!apiKey}
                    label={t("aiAccounts.add.openKeys", { site: site.host })}
                  />
                }
              >
                {"plans" in maker && maker.plans ? (
                  <Text variant="small" tone="muted">
                    {t("connectAi.key.notPlan")}
                  </Text>
                ) : null}
              </Step>
              <Step n={2} title={t("connectAi.key.paste")}>
                <TextInput
                  value={apiKey}
                  onChangeText={(v) => onDraft({ provider, apiKey: v })}
                  onBlur={() => setTouched(true)}
                  placeholder={maker.placeholder}
                  placeholderTextColor={c.faint}
                  accessibilityLabel={t("connectAi.key.paste")}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  spellCheck={false}
                  secureTextEntry
                  textContentType="none"
                  returnKeyType="done"
                  onSubmitEditing={() => {
                    setTouched(true);
                    if (valid) onSave?.();
                  }}
                  style={[
                    styles.input,
                    { color: c.ink, backgroundColor: c.bg, boxShadow: `${shadows.e1}, ${shadows.top}` },
                  ]}
                />
                {onSave ? (
                  <View style={styles.start}>
                    <Button
                      size="sm"
                      variant="primary"
                      label={saving ? t("mobile.ai.saving") : t("settings.saveKey")}
                      disabled={!valid || saving}
                      onPress={onSave}
                    />
                  </View>
                ) : null}
                {wrong ? (
                  <View style={styles.rowGap}>
                    <Note icon="x" live>
                      {t(`onboarding.keyInvalid.${provider}`)}
                    </Note>
                    {others.length > 0 ? (
                      <View style={styles.others}>
                        <Text variant="small" tone="muted">
                          {t("onboarding.keyFromOther")}
                        </Text>
                        {others.map((p) => (
                          <Pressable
                            key={p.id}
                            onPress={() => pick(p.id)}
                            accessibilityRole="button"
                            style={[styles.other, { backgroundColor: c.chip }]}
                          >
                            <ProviderLogo id={p.id} size="xs" />
                            <Text variant="small" tone="ink" style={styles.bold}>
                              {p.label}
                            </Text>
                          </Pressable>
                        ))}
                      </View>
                    ) : null}
                  </View>
                ) : null}
                {failed ? (
                  <Note icon="x" live>
                    {t("mobile.ai.failed")}
                  </Note>
                ) : null}
              </Step>
              <Note icon="help">{t("connectAi.key.forAll")}</Note>
            </>
          ) : null}
        </>
      )}
    </Panel>
  );
}

const styles = StyleSheet.create({
  picker: { gap: 10 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  cell: { width: "48%", flexGrow: 1, paddingHorizontal: 10 },
  tile: { flexDirection: "row", alignItems: "center", gap: 10 },
  tileTitle: { flex: 1, minWidth: 0, fontWeight: "600" },
  room: { paddingRight: 22 },
  or: { marginTop: 6 },
  keyRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  heavy: { fontWeight: "700" },
  panel: { borderRadius: 18, padding: 14, gap: 14 },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  agent: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    minHeight: 30,
    paddingHorizontal: 12,
    borderRadius: 999,
  },
  rowGap: { gap: 10 },
  start: { alignSelf: "flex-start" },
  after: { paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth },
  input: {
    minHeight: 46,
    borderRadius: 13,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginTop: 4,
    ...fieldText("body"),
  },
  others: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  other: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 30,
    paddingHorizontal: 10,
    borderRadius: 999,
  },
});
