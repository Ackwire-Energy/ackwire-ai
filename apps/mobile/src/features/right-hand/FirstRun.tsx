import type { Agent } from "@agenteschat/client";
import {
  useAgentBrain,
  useAiStatus,
  useCatalog,
  useConfirmSetup,
  useConnections,
  useInvitations,
  useMembers,
  useModelLabel,
  useModels,
} from "@agenteschat/client";
import { brainLine } from "@agenteschat/client/lib/brain";
import { emailName, firstName, joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { stepPermissions } from "@agenteschat/client/lib/home";
import { aiStateOf, planHoldPhoneLine } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { apiProviderOf, isAuto } from "@agenteschat/client/lib/providers";
import type { FirstRunState } from "@agenteschat/client/lib/right-hand";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { connectorName } from "@agenteschat/client/lib/scopes";
import {
  beatRow,
  type FirstRunFacts,
  type FirstRunStep,
  firstRunAiLabel,
  firstRunAsks,
  firstRunBeats,
  firstRunDone,
  firstRunRow,
  firstRunRowState,
  firstRunSteps,
} from "@agenteschat/client/lib/setup-checklist";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import type { IconName } from "@/ui";
import { router } from "@/ui/navigation";
import { SetupAsks, SetupCardView, useDoneSay } from "../agents/setup/SetupCard";
import { openSetupStep } from "../agents/setup/SetupStepScreen";
import { openConnectAi } from "../ai/NoAiCard";
import { usePlanHold } from "../ai/parts";
import { useDirectory, useMeId } from "../shared/hooks";
import { tapHaptic } from "../shared/parts";
import { useSendAnswer } from "./TeamCard";

/*
 * The right hand's first run on the phone (ADR 0155 §6, ADR 0158), as on the web: one checklist card inside its
 * greeting for the workspace's owners, with what the onboarding didn't do (an AI, apps, people), each row Connect AI,
 * a pushed screen or the invite screen. On a billing hold every row waits, the AI row saying where the plan is in
 * words only (App Store 3.1.1).
 */

const ROW_ICON: Record<FirstRunStep, IconName> = {
  ai: "brain",
  apps: "bolt",
  people: "person",
};

/** Where the card stands for this person, and what its rows read (Conversas reads it too). */
export function useFirstRun(agent: Agent | undefined) {
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const meId = useMeId();
  const may = stepPermissions(org, meId, dir.agents);
  const steps = !agent
    ? []
    : firstRunSteps(agent, {
        owner: org?.role === "owner",
        connectAi: may.connectAi,
        pay: may.pay,
        connectors: can(org, "manage_connectors"),
        invite: may.invite,
      });
  const status = useAiStatus(orgId);
  const members = useMembers(orgId);
  const invitations = useInvitations(orgId, steps.includes("people"));
  const connections = useConnections(orgId, steps.includes("apps"));
  const held = usePlanHold(orgId, org) !== null;
  const team = dir.agents.filter((a) => !isRightHand(a));
  const aiState = agent ? aiStateOf(status.data, agent.id) : undefined;
  const live = (connections.data ?? []).filter((c) => !c.revokedAt);
  const waiting = invitations.data ?? [];
  const facts: FirstRunFacts = {
    ai: !held && (aiState === "ready" || aiState === "waiting"),
    apps: live.length > 0,
    people: (members.data?.length ?? 1) > 1 || waiting.length > 0,
  };
  const done = agent?.setup && steps.length > 0 ? firstRunDone(agent.setup, facts) : new Set<FirstRunStep>();
  const left = steps.filter((s) => !done.has(s));
  const state: FirstRunState = steps.length === 0 ? "none" : left.length > 0 ? "open" : "complete";
  return {
    steps,
    done,
    facts,
    held,
    team,
    state,
    ready: status.isSuccess && members.isSuccess,
    members: members.data?.length ?? 1,
    invited: waiting.map((i) => emailName(i.email)),
    connections: live,
  };
}

export function FirstRunCard({ agent, channelId }: { agent: Agent; channelId: string }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const send = useSendAnswer(channelId);
  const confirm = useConfirmSetup(orgId, agent.id);
  const run = useFirstRun(agent);
  const catalog = useCatalog();
  const dir = useDirectory();
  const modelLabel = useModelLabel();
  const models = useModels();
  // Through the API, the workspace's key it runs on names its maker, as on the web (Automático names none).
  const keyMaker = useAgentBrain(orgId, agent.id).data?.workspaceAi?.key?.provider;
  const { steps, done, held, team, facts } = run;
  const doneHere = steps.filter((s) => done.has(s));
  // "Agora não" moves the row on and says nothing: only something done gets its line. An invitation is only sent: its
  // line says so, and someone joining gets the welcome.
  const said = useDoneSay(
    run.ready,
    firstRunBeats(doneHere, { members: run.members, invited: run.invited.length }),
    (beat) =>
      beat === "invited"
        ? t("agentSetup.firstRun.say.invited")
        : facts[beat]
          ? t(`agentSetup.firstRun.say.${beat}`, agentGrammar(agent.name))
          : "",
  );
  if (run.state === "none") return null;

  // The apps it reads, by name, as on the web ("Leio GitHub e Linear").
  const names = run.connections.flatMap((c) => {
    const def = catalog.data?.connectors.find((d) => d.id === c.connector);
    return def ? [connectorName(t, def)] : [];
  });
  const appNames = names.length ? joinNames(names, t) : null;
  // The AI it thinks with, as the web names it: an API key's maker ("Claude"), a plan's line.
  const ownerName = agent.ownerUserId ? dir.memberById.get(agent.ownerUserId)?.name : undefined;
  const thinks = brainLine(
    t,
    agent.brain,
    isAuto(agent.model) ? t("brain.auto.label") : (modelLabel(agent.model) ?? agent.model),
    { owner: ownerName ? firstName(ownerName) : undefined, agents: dir.agents },
  );
  const label = firstRunAiLabel(thinks, keyMaker ?? apiProviderOf(agent.model, models.data?.models ?? []));
  const stateOf = (s: FirstRunStep) => firstRunRowState(s, { done, held });
  const next = steps.find((s) => stateOf(s) === "open");
  const act: Record<FirstRunStep, () => void> = {
    // For the whole team, as the web's row: with agents besides it, every agent of the person's is chosen.
    ai: () => openConnectAi(team.length > 0 ? {} : { agentId: agent.id }),
    apps: () => openSetupStep(agent.id, "apps"),
    people: () => router.push("/invite-people"),
  };
  const rows = steps.map((s) => {
    const state = stateOf(s);
    const words = firstRunRow(
      t,
      s,
      state,
      {
        org: org?.name ?? "",
        label,
        apps: appNames,
        members: run.members,
        invited: run.invited.length ? joinNames(run.invited, t) : null,
      },
      agent.setup?.done.includes(s) ?? false,
    );
    // On a hold, the AI row says where the plan is chosen, in words only (App Store 3.1.1).
    const plan = s === "ai" && state === "afterPlan";
    return {
      key: s,
      icon: ROW_ICON[s],
      done: state === "done",
      title: plan ? planHoldPhoneLine(t, can(org, "manage_billing")) : words.title,
      desc: plan ? undefined : words.desc,
      dim: state === "afterPlan",
      saying: said && beatRow(said.step) === s ? said.text : null,
      ...(words.action
        ? {
            action: {
              label: words.action,
              primary: s === next,
              onPress: () => {
                tapHaptic();
                act[s]();
              },
            },
          }
        : {}),
      ...(words.skip && (s === "apps" || s === "people")
        ? { skip: { label: words.skip, busy: confirm.isPending, onPress: () => confirm.mutate(s) } }
        : {}),
    };
  });

  // What to ask it. The team's first task is offered once, by the team card ("Primeira tarefa"), never here too.
  const asks = firstRunAsks(done, held, team.length > 0)
    ? (["fit", "who"] as const).map((k) => ({
        label: t(`agentSetup.firstRun.asks.${k}`),
        onPress: () => send(t(`agentSetup.firstRun.asks.${k}`)),
      }))
    : [];

  // One question at a time, as in a conversation: the next open step with its button, and a step just done while it
  // says so; the count says how far the rest is ("1 de 3"). Complete, the card keeps every row as the record.
  const focus = next ?? rows.find((r) => !r.done && !r.dim)?.key;
  const shown = run.state === "complete" ? rows : rows.filter((r) => r.key === focus || r.saying);

  return (
    <SetupCardView
      title={
        run.state === "complete"
          ? t("agentSetup.firstRun.complete")
          : t("agentSetup.firstRun.title", { org: org?.name ?? "" })
      }
      done={doneHere.length}
      total={steps.length}
      rows={shown.length > 0 ? shown : rows}
      foot={asks.length > 0 ? <SetupAsks lead={t("agentSetup.firstRun.asks.lead")} asks={asks} /> : null}
    />
  );
}
