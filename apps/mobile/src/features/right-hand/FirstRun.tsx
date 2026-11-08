import type { Agent } from "@agenteschat/client";
import {
  useAiStatus,
  useCatalog,
  useConfirmSetup,
  useConnections,
  useMembers,
  useMessages,
  useModelLabel,
  useSettings,
} from "@agenteschat/client";
import { teamProposalOf } from "@agenteschat/client/lib/action-cards";
import { brainLine } from "@agenteschat/client/lib/brain";
import { firstName, joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { stepPermissions } from "@agenteschat/client/lib/home";
import { aiStateOf, planHoldPhoneLine } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { isAuto } from "@agenteschat/client/lib/providers";
import type { FirstRunState } from "@agenteschat/client/lib/right-hand";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { connectorName } from "@agenteschat/client/lib/scopes";
import {
  type FirstRunStep,
  firstRunAsks,
  firstRunDone,
  firstRunRow,
  firstRunRowState,
  firstRunSteps,
} from "@agenteschat/client/lib/setup-checklist";
import { answerAfter, firstTasks, teamStatus } from "@agenteschat/client/lib/team-plan";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import type { IconName } from "@/ui";
import { router } from "@/ui/navigation";
import { SetupAsks, SetupCardView, useDoneSay } from "../agents/setup/SetupCard";
import { openSetupStep } from "../agents/setup/SetupStepScreen";
import { openConnectAi } from "../ai/NoAiCard";
import { usePlanHold } from "../ai/parts";
import { useOpenDm } from "../new/useOpenDm";
import { useDirectory, useMeId } from "../shared/hooks";
import { tapHaptic } from "../shared/parts";
import { TeamTemplatesSheet, useSendAnswer } from "./TeamCard";

/*
 * The right hand's first run on the phone (ADR 0155 §6), as on the web: one checklist card inside its greeting for
 * the workspace's owners, five rows, each a pushed screen (what the workspace does, the apps), a sheet (the team's
 * templates), Connect AI or the invite screen. On a billing hold the AI row says so in words (App Store 3.1.1).
 */

const ROW_ICON: Record<FirstRunStep, IconName> = {
  about: "doc",
  team: "members",
  ai: "brain",
  apps: "bolt",
  people: "person",
};

/** Row 1's screen saved a business with a template: the card opens that template once it is back in view. */
let templatesAfterAbout: ((template: string | undefined) => void) | null = null;
export const openTemplatesAfterAbout = (template: string | undefined) => templatesAfterAbout?.(template);

/** Where the card stands for this person, and what its rows read; Conversas reads it with no conversation (null). */
export function useFirstRun(agent: Agent | undefined, channelId: string | null) {
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const meId = useMeId();
  const may = stepPermissions(org, meId, dir.agents);
  const steps = !agent
    ? []
    : firstRunSteps(agent, {
        owner: org?.role === "owner",
        configure: can(org, "configure"),
        createAgents: may.createAgents,
        connectAi: may.connectAi,
        pay: may.pay,
        connectors: can(org, "manage_connectors"),
        invite: may.invite,
      });
  const status = useAiStatus(orgId);
  const members = useMembers(orgId);
  const settings = useSettings(orgId);
  const connections = useConnections(orgId, steps.includes("apps"));
  const messages = useMessages(orgId, channelId ?? "", channelId !== null).data;
  const held = usePlanHold(orgId, org) !== null;
  const team = dir.agents.filter((a) => !isRightHand(a));
  const aiState = agent ? aiStateOf(status.data, agent.id) : undefined;
  const live = (connections.data ?? []).filter((c) => !c.revokedAt);
  const done =
    agent?.setup && steps.length > 0
      ? firstRunDone(agent.setup, {
          context: Boolean(settings.data?.context.trim()),
          team: team.length > 0,
          ai: !held && (aiState === "ready" || aiState === "waiting"),
          apps: live.length > 0,
          people: (members.data?.length ?? 1) > 1,
        })
      : new Set<FirstRunStep>();
  const cards = (messages ?? []).flatMap((m) => {
    const card = teamProposalOf(m.meta);
    return card ? [card] : [];
  });
  const left = steps.filter((s) => !done.has(s));
  const state: FirstRunState = steps.length === 0 ? "none" : left.length > 0 ? "open" : "complete";
  return {
    steps,
    done,
    held,
    team,
    state,
    ready: status.isSuccess && members.isSuccess && settings.isSuccess,
    members: members.data?.length ?? 1,
    connections: live,
    teamCard: cards.some((c) => teamStatus(c) === "open"),
    created: cards.filter((c) => c.state === "created").at(-1) ?? null,
    typed: answerAfter(messages, null),
  };
}

export function FirstRunCard({ agent, channelId }: { agent: Agent; channelId: string }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const openDm = useOpenDm();
  const send = useSendAnswer(channelId);
  const confirm = useConfirmSetup(orgId, agent.id);
  const run = useFirstRun(agent, channelId);
  const catalog = useCatalog();
  const dir = useDirectory();
  const modelLabel = useModelLabel();
  const [templates, setTemplates] = useState<{ initial?: string } | null>(null);
  const { steps, done, held, team } = run;
  // Once, while the team row is still open for this person.
  const teamOpen = useRef(false);
  teamOpen.current = steps.includes("team") && !done.has("team");
  useEffect(() => {
    templatesAfterAbout = (initial) => {
      if (teamOpen.current) setTemplates(initial ? { initial } : {});
    };
    return () => {
      templatesAfterAbout = null;
    };
  }, []);
  const doneHere = steps.filter((s) => done.has(s));
  const said = useDoneSay(run.ready, doneHere, (step) =>
    t(`agentSetup.firstRun.say.${step}`, agentGrammar(agent.name)),
  );
  if (run.state === "none") return null;

  // The apps it reads, by name, as on the web ("Leio GitHub e Linear").
  const names = run.connections.flatMap((c) => {
    const def = catalog.data?.connectors.find((d) => d.id === c.connector);
    return def ? [connectorName(t, def)] : [];
  });
  const appNames = names.length ? joinNames(names, t) : null;
  // What it thinks with, as the web names it ("Penso com Sonnet pelo plano do Claude").
  const ownerName = agent.ownerUserId ? dir.memberById.get(agent.ownerUserId)?.name : undefined;
  const label = brainLine(
    t,
    agent.brain,
    isAuto(agent.model) ? t("brain.auto.label") : (modelLabel(agent.model) ?? agent.model),
    { owner: ownerName ? firstName(ownerName) : undefined, agents: dir.agents },
  ).text;
  const stateOf = (s: FirstRunStep) => firstRunRowState(s, { done, held, teamCard: run.teamCard });
  const next = steps.find((s) => stateOf(s) === "open");
  const act: Record<FirstRunStep, () => void> = {
    about: () => openSetupStep(agent.id, "about", run.typed),
    team: () => (done.has("team") ? router.push("/team" as never) : setTemplates({})),
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
      { org: org?.name ?? "", agents: team.length, label, apps: appNames, members: run.members },
      agent.setup?.done.includes(s) ?? false,
    );
    return {
      key: s,
      icon: ROW_ICON[s],
      done: state === "done",
      // On a hold, the AI row says where the plan is chosen, in words only (App Store 3.1.1).
      title: state === "plan" ? planHoldPhoneLine(t, can(org, "manage_billing")) : words.title,
      desc: state === "plan" ? undefined : words.desc,
      dim: state === "afterPlan" || state === "card" || state === "plan",
      saying: said?.step === s ? said.text : null,
      ...(words.action && state !== "plan"
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

  const first = run.created ? firstTasks(run.created)[0] : undefined;
  const asks = firstRunAsks(done, held)
    ? [
        ...(first
          ? [
              {
                label: t("rightHand.intro.next.firstTask", agentGrammar(first.name)),
                onPress: () => void openDm({ agentId: first.agentId }, { compose: true, text: first.task }),
              },
            ]
          : []),
        ...(["fit", "who"] as const).map((k) => ({
          label: t(`agentSetup.firstRun.asks.${k}`),
          onPress: () => send(t(`agentSetup.firstRun.asks.${k}`)),
        })),
      ]
    : [];

  // One question at a time, as in a conversation: the next open step with its button, and a step just done while it
  // says so; the count says how far the rest is ("2 de 5"). Complete, the card keeps every row as the record.
  const focus = next ?? rows.find((r) => !r.done && !r.dim)?.key;
  const shown = run.state === "complete" ? rows : rows.filter((r) => r.key === focus || r.saying);

  return (
    <>
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
      <TeamTemplatesSheet
        open={templates !== null}
        initial={templates?.initial}
        onClose={() => setTemplates(null)}
        onNone={() => setTemplates(null)}
      />
    </>
  );
}
