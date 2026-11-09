import type { Agent } from "@agenteschat/client";
import {
  useAgentBrain,
  useAiStatus,
  useCatalog,
  useConfirmSetup,
  useConnections,
  useInvitations,
  useInviteMany,
  useMembers,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { emailName, joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { stepPermissions } from "@agenteschat/client/lib/home";
import { aiStateOf } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { connectorName } from "@agenteschat/client/lib/scopes";
import {
  beatRow,
  type FirstRunFacts,
  type FirstRunStep,
  firstRunAiLabel,
  firstRunAppList,
  firstRunAsks,
  firstRunBeats,
  firstRunDone,
  firstRunRow,
  firstRunRowState,
  firstRunSteps,
} from "@agenteschat/client/lib/setup-checklist";
import { Button, type IconName, Input } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SetupAsks, SetupCardView, StepDialog, useDoneSay } from "@/components/AgentSetup";
import { usePlanHold } from "@/components/ai/ConnectAiSteps";
import { useConnectAi } from "@/components/ConnectAi";
import { ConnectFlow, type FlowState } from "@/components/ConnectFlow";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { useChannelActions } from "@/components/channel-actions";
import { useInviteDialog } from "@/components/invite/InviteDialog";
import { useOrg } from "@/components/org-context";
import { useAgentThinks } from "@/hooks/useAgentThinks";
import { useDirectory } from "@/hooks/useDirectory";

/*
 * The right hand's first run (ADR 0155 §6, ADR 0158): one checklist card inside its greeting, drawn by the app and
 * never stored, for the workspace's owners, with what the onboarding didn't do: an AI, apps, people. Each row opens
 * in place, none needing a model, and reads done from the data; only "Agora não" is kept. On a billing hold every row
 * waits for the plan, whose one button is the hold's banner.
 */

const ROW_ICON: Record<FirstRunStep, IconName> = {
  ai: "bolt",
  apps: "plug",
  people: "personAdd",
};

/** The rows this person sees on the right hand's card (none: the card isn't theirs). */
export function useFirstRunSteps(agent: Agent | undefined): FirstRunStep[] {
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  if (!agent) return [];
  const may = stepPermissions(org, me.user.id, dir.agents);
  return firstRunSteps(agent, {
    owner: org.role === "owner",
    connectAi: may.connectAi,
    pay: may.pay,
    connectors: can(org, "manage_connectors"),
    invite: may.invite,
  });
}

/** Where the card stands for this person: `open` while a row is left, `complete`, or `none` (not theirs). */
export function useFirstRun(agent: Agent | undefined) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const steps = useFirstRunSteps(agent);
  const status = useAiStatus(org.id);
  const members = useMembers(org.id);
  const invitations = useInvitations(org.id, steps.includes("people"));
  const connections = useConnections(org.id, steps.includes("apps"));
  const live = (connections.data ?? []).filter((c) => !c.revokedAt);
  const held = usePlanHold() !== null;
  const team = dir.agents.filter((a) => !isRightHand(a));
  const aiState = agent ? aiStateOf(status.data, agent.id) : undefined;
  const waiting = invitations.data ?? [];
  const facts: FirstRunFacts = {
    ai: !held && (aiState === "ready" || aiState === "waiting"),
    apps: live.length > 0,
    people: (members.data?.length ?? 1) > 1 || waiting.length > 0,
  };
  const done = agent?.setup && steps.length > 0 ? firstRunDone(agent.setup, facts) : new Set<FirstRunStep>();
  const ready =
    status.isSuccess &&
    members.isSuccess &&
    (!steps.includes("apps") || connections.isSuccess) &&
    (!steps.includes("people") || !invitations.isPending);
  const left = steps.filter((s) => !done.has(s));
  return {
    steps,
    done,
    facts,
    ready,
    held,
    team,
    connections: live,
    members: members.data?.length ?? 1,
    invited: waiting.map((i) => emailName(i.email)),
    state: steps.length === 0 ? ("none" as const) : left.length > 0 ? ("open" as const) : ("complete" as const),
  };
}

/** The card, under the right hand's greeting. */
export function FirstRunCard({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const connect = useConnectAi();
  const invite = useInviteDialog();
  const actions = useChannelActions();
  const catalog = useCatalog();
  const confirm = useConfirmSetup(org.id, agent.id);
  const run = useFirstRun(agent);
  const thinks = useAgentThinks(agent);
  // Through the API, the workspace's key it runs on names its maker, as the side panel does (Automático names none).
  const keyMaker = useAgentBrain(org.id, agent.id).data?.workspaceAi?.key?.provider;
  const [open, setOpen] = useState<"apps" | null>(null);
  const burstRef = useRef<HTMLCanvasElement>(null);
  const { steps, done, held, team, facts } = run;
  const doneHere = steps.filter((s) => done.has(s));
  // "Agora não" moves the row on and says nothing: only something done gets its line and its burst. An invitation is
  // only sent: its line says so, with no burst, which waits for someone joining.
  const said = useDoneSay(
    run.ready,
    firstRunBeats(doneHere, { members: run.members, invited: run.invited.length }),
    steps.length,
    agent.appearance?.color,
    burstRef,
    (beat) =>
      beat === "invited"
        ? t("agentSetup.firstRun.say.invited")
        : facts[beat]
          ? t(`agentSetup.firstRun.say.${beat}`, agentGrammar(agent.name))
          : "",
    (beat) => beat !== "invited",
  );
  if (run.state === "none") return null;

  const defs = catalog.data?.connectors ?? [];
  const appNames = run.connections.flatMap((c) => {
    const def = defs.find((d) => d.id === c.connector);
    return def ? [connectorName(t, def)] : [];
  });
  const stateOf = (s: FirstRunStep) => firstRunRowState(s, { done, held });
  const next = steps.find((s) => stateOf(s) === "open");
  const skip = (step: "apps" | "people") => confirm.mutate(step);
  const act: Record<FirstRunStep, () => void> = {
    // For the whole team: no one agent named, so the dialog offers them all.
    ai: () => connect?.open({ agentIds: [agent.id, ...team.map((a) => a.id)] }),
    apps: () => setOpen("apps"),
    people: () => invite?.open(),
  };
  const label = thinks ? firstRunAiLabel(thinks, keyMaker ?? thinks.mark) : null;
  const rows = steps.map((s) => {
    const state = stateOf(s);
    // People, open: an address to send at once in the row, the dialog behind "Mais opções".
    const inline = s === "people" && state === "open" && invite !== null && can(org, "invite_people");
    const words = firstRunRow(
      t,
      s,
      state,
      {
        org: org.name,
        label,
        apps: appNames.length ? joinNames(appNames, t) : null,
        members: run.members,
        invited: run.invited.length ? joinNames(run.invited, t) : null,
      },
      agent.setup?.done.includes(s) ?? false,
    );
    return {
      key: s,
      icon: ROW_ICON[s],
      done: state === "done",
      title: words.title,
      desc: words.desc,
      dim: state === "afterPlan",
      saying: said && beatRow(said.step) === s ? said.text : null,
      ...(words.action && !inline && (s !== "ai" || connect) && (s !== "people" || invite)
        ? { action: { label: words.action, primary: s === next, onClick: act[s] } }
        : {}),
      ...(words.skip && (s === "apps" || s === "people") && !inline
        ? { skip: { label: words.skip, busy: confirm.isPending, onClick: () => skip(s) } }
        : {}),
      ...(inline
        ? {
            form: (
              <InviteLine
                onMore={() => invite?.open()}
                skip={words.skip ? { label: words.skip, busy: confirm.isPending, onClick: () => skip("people") } : null}
              />
            ),
          }
        : {}),
    };
  });

  // What to ask it. The team's first task is offered once, by the team card ("Primeira tarefa"), never here too.
  const asks = firstRunAsks(done, held, team.length > 0)
    ? (["fit", "who"] as const).map((k) => ({
        label: t(`agentSetup.firstRun.asks.${k}`),
        onClick: () => actions?.resend(t(`agentSetup.firstRun.asks.${k}`)),
      }))
    : [];

  return (
    <SetupCardView
      title={
        run.state === "complete" ? t("agentSetup.firstRun.complete") : t("agentSetup.firstRun.title", { org: org.name })
      }
      done={doneHere.length}
      total={steps.length}
      place="dm"
      burstRef={burstRef}
      rows={rows}
      foot={asks.length > 0 && <SetupAsks lead={t("agentSetup.firstRun.asks.lead")} asks={asks} />}
    >
      {open === "apps" && <AppsDialog team={team} onClose={() => setOpen(null)} />}
    </SetupCardView>
  );
}

/**
 * The people row's own line: one address and Enviar invites at once with the invite dialog's defaults, the dialog
 * itself behind "Mais opções" (several people, roles, channels, a note), and "Agora não" beside it, under the field.
 */
function InviteLine({
  onMore,
  skip,
}: {
  onMore: () => void;
  skip: { label: string; busy: boolean; onClick: () => void } | null;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const send = useInviteMany(org.id);
  const [email, setEmail] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  const address = email.trim();
  const submit = () =>
    send.mutate(
      { emails: [address] },
      {
        onSuccess: ([out]) => {
          if (out?.status === "invalid_email") return setRefused(t("members.batch.invalid_email", { email: address }));
          setRefused(null);
          setEmail("");
        },
        onError: (e) => setRefused(errorText(t, e)),
      },
    );
  return (
    <form
      className="setup-invite"
      onSubmit={(e) => {
        e.preventDefault();
        if (address && !send.isPending) submit();
      }}
    >
      <span className="setup-invite__line">
        <Input
          type="email"
          className="setup-invite__email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t("agentSetup.firstRun.people.email")}
          aria-label={t("auth.email")}
          disabled={send.isPending}
        />
        <Button type="submit" size="sm" variant="primary" disabled={!address} loading={send.isPending}>
          {t("agentSetup.firstRun.people.send")}
        </Button>
      </span>
      {refused && (
        <span className="setup-invite__error" role="alert">
          {refused}
        </span>
      )}
      <span className="setup-invite__more">
        <button type="button" className="ac-link" onClick={onMore}>
          {t("agentSetup.firstRun.people.more")}
        </button>
        {skip && (
          <button type="button" className="ac-link" disabled={skip.busy} onClick={skip.onClick}>
            {skip.label}
          </button>
        )}
      </span>
    </form>
  );
}

/**
 * The apps row: the apps the team just made would use (its roles' suggestions), plug-and-play ones only, each with Conectar
 * (the same connect dialog as Settings, whose last step says which agents use it: all of them, by default).
 */
function AppsDialog({ team, onClose }: { team: Agent[]; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const catalog = useCatalog();
  const connections = useConnections(org.id);
  const [flow, setFlow] = useState<FlowState | null>(null);
  const connected = new Set((connections.data ?? []).filter((c) => !c.revokedAt).map((c) => c.connector));
  const list = firstRunAppList(catalog.data?.connectors ?? [], connected, team);
  return (
    <>
      <StepDialog
        title={t("agentSetup.firstRun.apps.title")}
        description={t("agentSetup.firstRun.apps.desc")}
        ok={t("common.close")}
        cancel={false}
        busy={false}
        onOk={onClose}
        onClose={onClose}
        note={
          <button
            type="button"
            className="ac-link"
            onClick={() =>
              void navigate({ to: "/org/$orgId/settings/$section", params: { orgId: org.id, section: "connectors" } })
            }
          >
            {t("agentSetup.firstRun.apps.all")}
          </button>
        }
      >
        <ul className="setup-apps">
          {list.map(({ def, suggested }) => (
            <li key={def.id} className="setup-apps__row">
              <ConnectorIcon def={def} label={connectorName(t, def)} />
              <b>{connectorName(t, def)}</b>
              {suggested && <small>{t("agentSetup.suggested")}</small>}
              <Button size="sm" onClick={() => setFlow({ step: 0, def })}>
                {t("agentSetup.firstRun.apps.connect")}
              </Button>
            </li>
          ))}
        </ul>
      </StepDialog>
      <ConnectFlow flow={flow} onChange={setFlow} onClose={() => setFlow(null)} />
    </>
  );
}
