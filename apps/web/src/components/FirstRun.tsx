import type { Agent } from "@agenteschat/client";
import {
  useAiStatus,
  useCatalog,
  useConfirmSetup,
  useConnections,
  useMembers,
  useMessages,
  useSettings,
  useUpdateSettings,
} from "@agenteschat/client";
import { teamProposalOf } from "@agenteschat/client/lib/action-cards";
import { setDraftFor } from "@agenteschat/client/lib/drafts";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { stepPermissions } from "@agenteschat/client/lib/home";
import { aiStateOf } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { connectorName } from "@agenteschat/client/lib/scopes";
import {
  type FirstRunStep,
  firstRunAppList,
  firstRunAsks,
  firstRunDone,
  firstRunRow,
  firstRunRowState,
  firstRunSteps,
} from "@agenteschat/client/lib/setup-checklist";
import {
  answerAfter,
  BUSINESS_TYPES,
  type BusinessType,
  firstTasks,
  isTemplateBusiness,
  teamStatus,
} from "@agenteschat/client/lib/team-plan";
import { Button, Field, type IconName, Input, Locked } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SetupAsks, SetupCardView, StepDialog, useDoneSay } from "@/components/AgentSetup";
import { usePlanHold } from "@/components/ai/ConnectAiSteps";
import { BillingLinkButton } from "@/components/BillingLinkButton";
import { useConnectAi } from "@/components/ConnectAi";
import { ConnectFlow, type FlowState } from "@/components/ConnectFlow";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { useChannelActions } from "@/components/channel-actions";
import { useInviteDialog } from "@/components/invite/InviteDialog";
import { useOrg } from "@/components/org-context";
import { TeamTemplatesDialog } from "@/components/TeamPlan";
import { useAgentThinks } from "@/hooks/useAgentThinks";
import { useDirectory } from "@/hooks/useDirectory";

/*
 * The right hand's first run (ADR 0155 §6): one checklist card inside its greeting, drawn by the app and never stored,
 * for the workspace's owners. Five rows, each opening a dialog in place, none needing a model: what the workspace
 * does, the team (a template, made in one click), an AI, apps, people. A row reads done from the data; only "Agora
 * não" is kept. On a billing hold the AI row leads to the plan and apps and people wait for it.
 */

const ROW_ICON: Record<FirstRunStep, IconName> = {
  about: "document",
  team: "members",
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
    configure: can(org, "configure"),
    createAgents: may.createAgents,
    connectAi: may.connectAi,
    pay: may.pay,
    connectors: can(org, "manage_connectors"),
    invite: may.invite,
  });
}

/**
 * Where the card stands for this person: `open` while a row is left, `complete`, or `none` (not theirs). Início reads
 * it with no conversation (`channelId` null): the rows' count alone.
 */
export function useFirstRun(agent: Agent | undefined, channelId: string | null) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const steps = useFirstRunSteps(agent);
  const status = useAiStatus(org.id);
  const members = useMembers(org.id);
  const detail = useSettings(org.id);
  const connections = useConnections(org.id, steps.includes("apps"));
  const live = (connections.data ?? []).filter((c) => !c.revokedAt);
  const messages = useMessages(org.id, channelId ?? "", channelId !== null).data;
  const held = usePlanHold() !== null;
  const team = dir.agents.filter((a) => !isRightHand(a));
  const aiState = agent ? aiStateOf(status.data, agent.id) : undefined;
  const done =
    agent?.setup && steps.length > 0
      ? firstRunDone(agent.setup, {
          context: Boolean(detail.data?.context?.trim()),
          team: team.length > 0,
          ai: !held && (aiState === "ready" || aiState === "waiting"),
          apps: live.length > 0,
          people: (members.data?.length ?? 1) > 1,
        })
      : new Set<FirstRunStep>();
  const ready =
    status.isSuccess && members.isSuccess && detail.isSuccess && (!steps.includes("apps") || connections.isSuccess);
  const cards = (messages ?? []).flatMap((m) => {
    const card = teamProposalOf(m.meta);
    return card ? [card] : [];
  });
  const left = steps.filter((s) => !done.has(s));
  return {
    steps,
    done,
    ready,
    held,
    team,
    connections: live,
    members: members.data?.length ?? 1,
    context: detail.data?.context ?? "",
    teamCard: cards.some((c) => teamStatus(c) === "open"),
    created: cards.filter((c) => c.state === "created").at(-1) ?? null,
    typed: answerAfter(messages, null),
    state: steps.length === 0 ? ("none" as const) : left.length > 0 ? ("open" as const) : ("complete" as const),
  };
}

/** The card, under the right hand's greeting. */
export function FirstRunCard({ agent, channelId }: { agent: Agent; channelId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const connect = useConnectAi();
  const invite = useInviteDialog();
  const actions = useChannelActions();
  const catalog = useCatalog();
  const confirm = useConfirmSetup(org.id, agent.id);
  const run = useFirstRun(agent, channelId);
  const thinks = useAgentThinks(agent);
  const [open, setOpen] = useState<"about" | "apps" | null>(null);
  const [templates, setTemplates] = useState<{ initial?: string } | null>(null);
  const burstRef = useRef<HTMLCanvasElement>(null);
  const { steps, done, held, team } = run;
  const doneHere = steps.filter((s) => done.has(s));
  const said = useDoneSay(run.ready, doneHere, steps.length, agent.appearance?.color, burstRef, (step) =>
    t(`agentSetup.firstRun.say.${step}`, agentGrammar(agent.name)),
  );
  if (run.state === "none") return null;

  const defs = catalog.data?.connectors ?? [];
  const appNames = run.connections.flatMap((c) => {
    const def = defs.find((d) => d.id === c.connector);
    return def ? [connectorName(t, def)] : [];
  });
  const stateOf = (s: FirstRunStep) => firstRunRowState(s, { done, held, teamCard: run.teamCard });
  const next = steps.find((s) => ["open", "plan"].includes(stateOf(s)));
  const skip = (step: "apps" | "people") => confirm.mutate(step);
  const act: Record<FirstRunStep, () => void> = {
    about: () => setOpen("about"),
    team: () =>
      done.has("team") ? void navigate({ to: "/org/$orgId/team", params: { orgId: org.id } }) : setTemplates({}),
    ai: () => connect?.open({ agentId: agent.id, agentIds: [agent.id, ...team.map((a) => a.id)] }),
    apps: () => setOpen("apps"),
    people: () => invite?.open(),
  };
  const rows = steps.map((s) => {
    const state = stateOf(s);
    const words = firstRunRow(
      t,
      s,
      state,
      {
        org: org.name,
        agents: team.length,
        label: thinks?.text ?? null,
        apps: appNames.length ? joinNames(appNames, t) : null,
        members: run.members,
      },
      agent.setup?.done.includes(s) ?? false,
    );
    const pay = state === "plan" && can(org, "manage_billing");
    return {
      key: s,
      icon: ROW_ICON[s],
      done: state === "done",
      title: words.title,
      desc: words.desc,
      dim: state === "afterPlan" || state === "card",
      saying: said?.step === s ? said.text : null,
      ...(pay
        ? {
            actionNode: (
              <BillingLinkButton orgId={org.id} from="hold" size="sm" variant={s === next ? "primary" : undefined}>
                {words.action}
              </BillingLinkButton>
            ),
          }
        : words.action && state !== "plan" && (s !== "ai" || connect) && (s !== "people" || invite)
          ? { action: { label: words.action, primary: s === next, onClick: act[s] } }
          : {}),
      ...(words.skip && (s === "apps" || s === "people")
        ? { skip: { label: words.skip, busy: confirm.isPending, onClick: () => skip(s) } }
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
                onClick: () => {
                  setDraftFor(`agent:${first.agentId}`, first.task);
                  void navigate({
                    to: "/org/$orgId/dm/agent/$agentId",
                    params: { orgId: org.id, agentId: first.agentId },
                  });
                },
              },
            ]
          : []),
        ...(["fit", "who"] as const).map((k) => ({
          label: t(`agentSetup.firstRun.asks.${k}`),
          onClick: () => actions?.resend(t(`agentSetup.firstRun.asks.${k}`)),
        })),
      ]
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
      {open === "about" && (
        <AboutDialog
          context={run.context}
          typed={run.typed}
          onClose={() => setOpen(null)}
          onSaved={(business) => {
            setOpen(null);
            // Straight into the team, once, with that business's template picked.
            if (!done.has("team") && steps.includes("team")) {
              setTemplates(business && isTemplateBusiness(business) ? { initial: business } : {});
            }
          }}
        />
      )}
      {open === "apps" && <AppsDialog team={team} onClose={() => setOpen(null)} />}
      <TeamTemplatesDialog open={templates !== null} initial={templates?.initial} onClose={() => setTemplates(null)} />
    </SetupCardView>
  );
}

/**
 * Row 1: "O que a Acme faz?", the business types to tap and one optional sentence; saved as the workspace's context,
 * which every agent reads. "Outra coisa" asks for the sentence. What the person already typed to the right hand comes
 * filled in.
 */
function AboutDialog({
  context,
  typed,
  onClose,
  onSaved,
}: {
  context: string;
  typed: string | null;
  onClose: () => void;
  onSaved: (business: BusinessType | null) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const save = useUpdateSettings(org.id);
  const [business, setBusiness] = useState<BusinessType | null>(null);
  const [line, setLine] = useState(context || typed || "");
  const other = business === "other";
  const text = line.trim() || (business && !other ? t(`teamPlan.business.${business}`) : "");
  return (
    <StepDialog
      title={t("agentSetup.firstRun.about.title", { org: org.name })}
      description={t("agentSetup.firstRun.about.desc")}
      ok={t("common.save")}
      okDisabled={!text}
      busy={save.isPending}
      onClose={onClose}
      onOk={() => save.mutate({ context: text }, { onSuccess: () => onSaved(business) })}
      note={save.isError ? <span className="setup-dlg__error">{errorText(t, save.error)}</span> : undefined}
    >
      <Locked when={save.isPending}>
        <div className="tp-chips__row">
          {BUSINESS_TYPES.map((b) => (
            <button
              key={b}
              type="button"
              className="tp-chip"
              aria-pressed={b === business}
              onClick={() => setBusiness(b === business ? null : b)}
            >
              {t(`teamPlan.business.${b}`)}
            </button>
          ))}
        </div>
        <Field
          label={t("agentSetup.firstRun.about.line")}
          hint={{
            name: t("common.about", { label: t("agentSetup.firstRun.about.line") }),
            text: other ? undefined : t("agentSetup.firstRun.about.optional"),
          }}
        >
          <Input value={line} onChange={(e) => setLine(e.target.value)} maxLength={500} required={other} />
        </Field>
      </Locked>
    </StepDialog>
  );
}

/**
 * Row 4: the apps the team just made would use (its roles' suggestions), plug-and-play ones only, each with Conectar
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
