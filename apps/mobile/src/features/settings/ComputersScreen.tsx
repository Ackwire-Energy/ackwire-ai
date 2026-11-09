import type { Machine, OrgSummary } from "@agenteschat/client";
import {
  useAgents,
  useAuthConfig,
  useComputerSetup,
  useHostComputer,
  useHostComputerOn,
  useMachines,
  useSetComputerTarget,
} from "@agenteschat/client";
import {
  computerEdition,
  computerName,
  type NoComputer,
  type SetupView,
  setupView,
} from "@agenteschat/client/lib/computer";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import { computerKind, computerState, installCommand, machineTitle } from "@agenteschat/client/lib/machines";
import { can } from "@agenteschat/client/lib/permissions";
import { helpUrl } from "@agenteschat/client/lib/server";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import type { TFunction } from "i18next";
import { Trans, useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { ComputerPortrait } from "@/computer/ComputerPortrait";
import { serverUrl } from "@/lib/server";
import { useOrg } from "@/providers/org";
import {
  Button,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  type GroupedRowProps,
  Text,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { Note, openPage } from "../ai/parts";
import { SetupWait } from "../computer/SetupWait";
import { computerIcon } from "../outages/logic";
import { AgentFace } from "../shared/Face";
import { firstUseCopy } from "../shared/first-use";
import { useColors, useMeId } from "../shared/hooks";
import { goBack, Loaded, successHaptic } from "../shared/parts";
import {
  type AgentComputerPick,
  agentComputerPick,
  machineFacts,
  NO_COMPUTER,
  noComputerKey,
  pauseText,
  peoplesMachines,
} from "./logic";
import { CommandBlock, Gap, SettingsPage } from "./parts";

/** Opens a computer's page. */
export const openMachine = (id: string) => router.push(`/settings/computers/${id}`);

/** "Usado por Infra e Dev", or that no agent uses it yet. */
export function usedByText(t: TFunction, agents: readonly { name: string }[]) {
  return agents.length > 0
    ? t("machines.usedBy", {
        names: joinNames(
          agents.map((a) => a.name),
          t,
        ),
      })
    : t("machines.noAgents");
}

/** A computer's row in the lists: its portrait, name, facts, who uses it, and online (or paused) on the right. */
function machineRow(t: TFunction, locale: string, m: Machine): GroupedRowProps {
  return {
    leading: <ComputerPortrait kind={computerKind(m.os)} state={computerState(m)} />,
    label: machineTitle(m, t("machines.host.label")),
    sub: machineFacts(t, locale, m),
    subLines: 2,
    below: (
      <Text variant="caption" tone="faint" numberOfLines={2}>
        {[usedByText(t, m.agents), m.execAllowed ? null : t("machines.execOff")].filter(Boolean).join(" · ")}
      </Text>
    ),
    value: pauseText(t, locale, m.paused) ?? (m.online ? t("machines.online") : t("machines.offline")),
    chevron: true,
  };
}

/**
 * What "no computer" stands for, by name: the workspace's own computer on its way reads in its mode's words (a
 * personal one's: its person's agents', ADR 0158), else plainly none.
 */
function noComputerName(t: TFunction, org: OrgSummary | null, choice: NoComputer) {
  const key = noComputerKey(choice);
  return t(choice === "workspace" ? modeKey(org, key) : key, { org: org?.name ?? "" });
}

/** A choice's name in "Qual computador cada agente usa": a computer by its name, or what "no computer" stands for. */
function choiceName(t: TFunction, org: OrgSummary | null, pick: AgentComputerPick, id: string) {
  if (id === NO_COMPUTER) return noComputerName(t, org, pick.noComputer ?? "none");
  const m = pick.choices.find((x) => x.id === id);
  return m ? machineTitle(m, t("machines.host.label")) : "";
}

/**
 * Computadores, as the web's. Where the workspace gets its own computer (ADR 0056 §10): its card and nothing else.
 * Where people bring their own: this server's computer, the other computers and how to connect one (the app goes on
 * the computer; a server's command to copy), which computer each agent uses, then how computers work.
 */
export function ComputersScreen() {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const { orgId } = useOrg();
  const setup = useComputerSetup(orgId);
  const view = setupView(setup.data, setup.dataUpdatedAt);
  const edition = computerEdition(setup.data);
  return (
    <SettingsPage title={t("settings.section.computers")}>
      {edition ? (
        <GroupedFooter>{edition === "cloud" ? t("computers.leadCloud") : t("computers.lead")}</GroupedFooter>
      ) : null}
      {/* No edition's words before the server says which this is: a failed answer is asked again, not guessed. */}
      {!setup.data ? (
        setup.isError ? (
          <View style={styles.note}>
            <Note icon="x">{t("common.loadFailed")}</Note>
            <Button size="sm" variant="secondary" label={t("common.retry")} onPress={() => void setup.refetch()} />
          </View>
        ) : (
          <ActivityIndicator color={c.muted} style={styles.loading} />
        )
      ) : view ? (
        <Loaded>
          <WorkspaceComputer view={view} />
        </Loaded>
      ) : (
        <Loaded>
          <HostComputer />
          <OtherComputers />
          <AgentComputers />
          <Gap />
          <GroupedList>
            <GroupedRow
              icon="help"
              label={t("computers.how")}
              chevron
              onPress={() => openPage(helpUrl("computers", i18n.language))}
            />
          </GroupedList>
        </Loaded>
      )}
    </SettingsPage>
  );
}

/** The workspace's own computer: how far it is (or that it is ready), and its page once it exists. */
function WorkspaceComputer({ view }: { view: SetupView }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const machine = useMachines(orgId).data?.find((m) => m.kind === "managed");
  return (
    <>
      <Gap />
      <GroupedList>
        <View style={styles.wait}>
          <SetupWait view={view} online={machine?.online ?? false} />
        </View>
      </GroupedList>
      {machine ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow
              icon={computerIcon(machine.os)}
              label={computerName(t, org?.name ?? "", machine, isPersonal(org))}
              sub={usedByText(t, machine.agents)}
              subLines={2}
              value={machine.online ? t("machines.online") : t("machines.offline")}
              chevron
              onPress={() => openMachine(machine.id)}
            />
          </GroupedList>
        </>
      ) : null}
    </>
  );
}

/**
 * This server's computer (`HOST_COMPUTER_TOKEN`), the machine agentes.chat is installed on. An admin who stopped it
 * here can use it again; with none, admins read how to make it one, but only while sign-up is closed.
 */
function HostComputer() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { orgId, org } = useOrg();
  const admin = can(org, "configure");
  const machines = useMachines(orgId);
  const host = useHostComputer(orgId);
  const auth = useAuthConfig();
  const turnOn = useHostComputerOn(orgId);
  const label = t("machines.host.label");
  const m = machines.data?.find((x) => x.kind === "host");
  const off = host.data?.on === false;
  const missing = host.isSuccess && host.data === null && admin && auth.data?.signupOpen === false;
  if (!m && !off && !missing) return null;
  return (
    <>
      <GroupedHeader>{label}</GroupedHeader>
      {m ? (
        <GroupedList>
          <GroupedRow {...machineRow(t, i18n.language, m)} onPress={() => openMachine(m.id)} />
        </GroupedList>
      ) : off ? (
        <GroupedList>
          <GroupedRow
            leading={<ComputerPortrait kind="linux" state="offline" />}
            label={label}
            sub={t("machines.host.offText")}
            subLines={2}
          />
          {admin ? (
            <GroupedRow
              icon="play"
              label={t("machines.host.use")}
              labelLines={2}
              disabled={turnOn.isPending}
              onPress={() =>
                turnOn.mutate(undefined, {
                  onSuccess: () => {
                    successHaptic();
                    toast({ title: t("machines.host.used"), icon: "check" });
                  },
                  onError: (err) => toast({ title: errorText(t, err), icon: "x" }),
                })
              }
            />
          ) : null}
        </GroupedList>
      ) : (
        <GroupedFooter>
          <Trans
            i18nKey="computers.hostMissing"
            components={{
              guide: (
                <Text
                  variant="footnote"
                  accessibilityRole="link"
                  style={styles.link}
                  onPress={() => openPage(helpUrl("install-on-a-server", i18n.language, "computers"))}
                />
              ),
            }}
          />
        </GroupedFooter>
      )}
    </>
  );
}

/** "Outros computadores": the computers people connected with a code (each opens its page), and how to connect one. */
function OtherComputers() {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const { orgId, org } = useOrg();
  const machines = useMachines(orgId);
  const list = peoplesMachines(machines.data ?? []);
  const pairs = can(org, "pair_computers");
  const noneCopy = firstUseCopy("computers", pairs);
  return (
    <>
      <GroupedHeader
        hint={{ name: t("common.about", { label: t("computers.other.title") }), text: t("computers.other.text") }}
      >
        {t("computers.other.title")}
      </GroupedHeader>
      {machines.isLoading ? <ActivityIndicator color={c.muted} style={styles.loading} /> : null}
      {machines.isError && !machines.data ? (
        <View style={styles.note}>
          <Note icon="x">{t("common.loadFailed")}</Note>
        </View>
      ) : null}
      {machines.isSuccess && list.length === 0 ? (
        <GroupedList>
          <View style={styles.empty}>
            <ComputerPortrait kind="mac" state="offline" size={96} />
            <Text variant="callout" tone="ink" style={[styles.bold, styles.emptyLine]}>
              {t(noneCopy.title)}
            </Text>
            <Text variant="small" tone="muted" style={styles.emptyLine}>
              {t(noneCopy.text)}
            </Text>
          </View>
        </GroupedList>
      ) : null}
      {list.length > 0 ? (
        <GroupedList>
          {list.map((m) => (
            <GroupedRow key={m.id} {...machineRow(t, i18n.language, m)} onPress={() => openMachine(m.id)} />
          ))}
        </GroupedList>
      ) : null}
      {pairs ? <ConnectComputer /> : null}
    </>
  );
}

/**
 * "Conectar outro computador" on a phone (ADR 0036 §2): the app goes on the computer itself (as the web says on a
 * phone, with no download here), and a server's or Linux's command, to copy and run there.
 */
function ConnectComputer() {
  const { t } = useTranslation();
  return (
    <>
      <GroupedHeader>{t("machines.download.title")}</GroupedHeader>
      <GroupedList>
        <GroupedRow icon="laptop" label={t("machines.download.text")} labelLines={3} />
      </GroupedList>
      <GroupedHeader>{t("machines.download.other")}</GroupedHeader>
      <CommandBlock command={installCommand(serverUrl())} />
      <GroupedFooter>{t("machines.download.otherText")}</GroupedFooter>
    </>
  );
}

/**
 * "Qual computador cada agente usa": each agent and its computer. Who manages agents picks any; an agent's owner,
 * the ones they connected (the server checks again); a row anyone else can't change only says it.
 */
function AgentComputers() {
  const { t } = useTranslation();
  const c = useColors();
  const { orgId, org } = useOrg();
  const meId = useMeId();
  const admin = can(org, "manage_agents");
  const agents = useAgents(orgId);
  const machines = useMachines(orgId);
  const setupQ = useComputerSetup(orgId);
  const setup = setupView(setupQ.data, setupQ.dataUpdatedAt);
  const list = agents.data ?? [];
  return (
    <>
      <GroupedHeader>{t("computers.agents.title")}</GroupedHeader>
      {agents.isLoading || machines.isLoading ? (
        <ActivityIndicator color={c.muted} style={styles.loading} />
      ) : list.length === 0 ? (
        <GroupedFooter>{t("computers.agents.empty")}</GroupedFooter>
      ) : (
        <GroupedList>
          {list.map((a) => {
            const pick = agentComputerPick({ agent: a, meId, admin, machines: machines.data ?? [], setup });
            return (
              <GroupedRow
                key={a.id}
                leading={<AgentFace agentId={a.id} size={30} live={false} />}
                label={a.name}
                value={choiceName(t, org?.name ?? "", pick, pick.value)}
                chevron={pick.canPick}
                {...(pick.canPick
                  ? {
                      onPress: () => router.push({ pathname: "/settings/computers/agent", params: { agentId: a.id } }),
                    }
                  : {})}
              />
            );
          })}
        </GroupedList>
      )}
    </>
  );
}

/**
 * "Computador de Dev", pushed from "Qual computador cada agente usa": the computers this person may pick for the
 * agent (online, paused or offline under each), and "no computer" where it means something; a pick saves and goes
 * back with a toast.
 */
export function AgentComputerScreen({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const { orgId, org } = useOrg();
  const meId = useMeId();
  const admin = can(org, "manage_agents");
  const agents = useAgents(orgId);
  const machines = useMachines(orgId);
  const setupQ = useComputerSetup(orgId);
  const setup = setupView(setupQ.data, setupQ.dataUpdatedAt);
  const setTarget = useSetComputerTarget(orgId);
  const agent = agents.data?.find((a) => a.id === agentId);
  if (!agent) {
    return (
      <SettingsPage title={t("computers.agents.title")}>
        {agents.isLoading ? <ActivityIndicator color={c.muted} style={styles.loading} /> : null}
      </SettingsPage>
    );
  }
  const pick = agentComputerPick({ agent, meId, admin, machines: machines.data ?? [], setup });
  const choose = (id: string) => {
    if (id === pick.value) {
      goBack();
      return;
    }
    setTarget.mutate(
      { agentId, machineId: id === NO_COMPUTER ? null : id },
      {
        onSuccess: () => {
          successHaptic();
          toast({
            title: t("computers.agents.saved", { name: agent.name, computer: choiceName(t, org, pick, id) }),
            icon: "check",
          });
          goBack();
        },
        onError: (err) => toast({ title: errorText(t, err), icon: "x" }),
      },
    );
  };
  return (
    <SettingsPage title={t("computers.agents.pick", { name: agent.name })}>
      <Gap />
      <GroupedList>
        {pick.noComputer ? (
          <GroupedRow
            icon={pick.noComputer === "workspace" ? computerIcon("other") : "circle"}
            label={noComputerName(t, org, pick.noComputer)}
            sub={pick.noComputer === "workspace" && setup ? t(setup.chipKey) : t("computer.target.noneText")}
            checked={pick.value === NO_COMPUTER}
            disabled={setTarget.isPending}
            onPress={() => choose(NO_COMPUTER)}
          />
        ) : null}
        {pick.choices.map((m) => (
          <GroupedRow
            key={m.id}
            icon={computerIcon(m.os)}
            label={machineTitle(m, t("machines.host.label"))}
            sub={t(`computers.agents.state.${computerState(m)}`)}
            checked={pick.value === m.id}
            disabled={setTarget.isPending}
            onPress={() => choose(m.id)}
          />
        ))}
      </GroupedList>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: 4, paddingTop: 10, gap: 10, alignItems: "flex-start" },
  loading: { marginVertical: 16 },
  wait: { padding: 16 },
  emptyLine: { textAlign: "center" },
  empty: { alignItems: "center", gap: 8, paddingVertical: 20, paddingHorizontal: 16 },
  bold: { fontWeight: "600" },
  link: { textDecorationLine: "underline" },
});
