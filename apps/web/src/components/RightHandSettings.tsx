import type { Agent, AgentBrainInput } from "@agenteschat/client";
import {
  keys,
  useAgentBrain,
  useApi,
  useCredentials,
  useModels,
  usePlatformKey,
  useSetTeamWeekPrefs,
  useTeamWeekPrefs,
  useUpdateAgent,
} from "@agenteschat/client";
import { audienceOf, audiencePatch } from "@agenteschat/client/lib/audience";
import { errorText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { handleAfterRename } from "@agenteschat/client/lib/new-agent";
import { can } from "@agenteschat/client/lib/permissions";
import { accountPlan, planReplies } from "@agenteschat/client/lib/plans";
import { AUTO, modelChoices } from "@agenteschat/client/lib/providers";
import { isRightHand, mineStatus } from "@agenteschat/client/lib/right-hand";
import {
  AffixInput,
  BrainLogo,
  Button,
  Card,
  CardFooter,
  CardHeader,
  Dialog,
  DialogBody,
  DialogFooter,
  Icon,
  InfoHint,
  Input,
  ProviderLogo,
  Select,
  Switch,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { AudienceChoice } from "@/components/AgentAudience";
import { AgentAvatar } from "@/components/AgentAvatar";
import { LookRows, ModelSelect, modelOptions } from "@/components/AgentFields";
import { PlanHold, usePlanHold } from "@/components/ai/ConnectAiSteps";
import { useConnectAi } from "@/components/ConnectAi";
import { PrefRow } from "@/components/NoticePrefs";
import { useOrg } from "@/components/org-context";
import { TeamWeekSchedule } from "@/components/TeamWeekCard";
import { useDirectory } from "@/hooks/useDirectory";
import { fullLook, lookOf } from "@/lib/look";
import { useToast } from "@/lib/toast";

/**
 * Configurações › Workspace › Lodi (ADR 0137): only what admins set for the team's right hand. Its name and look, its
 * AI and model, its own monthly budget and who may use it, each saved as it changes; one line says it can't be
 * archived or deleted, and its audit log is a click away. Its instructions are the product's.
 */
/** The plan's terms behind an ⓘ after a line (`planReplies`), as "Atende outras pessoas" says them everywhere. */
function PlanTerms({
  line,
  brain,
  plan,
  coding,
}: {
  line: string;
  brain: PlanKind;
  plan?: string | null;
  coding?: ReturnType<typeof accountPlan>;
}) {
  const { t } = useTranslation();
  const says = planReplies(t, { on: false, agent: null, brain, plan, coding });
  return (
    <span className="plan-replies__terms ac-hintline">
      <span>{line}</span>
      <InfoHint name={says.about}>{says.text}</InfoHint>
    </span>
  );
}

export function RightHandSettingsSection() {
  const { org } = useOrg();
  const agent = useDirectory(org.id).agents.find(isRightHand);
  return agent ? <RightHandForm agent={agent} /> : null;
}

/** A plan as its logo and its account's name (whose, to anyone but its owner), on a line of its own. */
function PlanLine({ kind, label, owner }: { kind: PlanKind; label?: string; owner?: string }) {
  const { t } = useTranslation();
  return (
    <>
      <BrainLogo kind={kind} size="xs" />
      <b>{label ?? t(`aiAccounts.connect.${kind}`)}</b>
      {owner && <span>{t("rightHand.settings.planOwner", { owner })}</span>}
    </>
  );
}

type PlanKind = "claude_code" | "codex" | "cursor" | "opencode" | "grok" | "antigravity";
const planKind = (kind: string | undefined): PlanKind | null => (kind && kind !== "model" ? (kind as PlanKind) : null);

/**
 * "Sua IA" (ADR 0137 §11) as one status, a MediaRow: the logo of what answers the viewer in their own DM with the right
 * hand, its name and what it is to them on one line (Claude · chave do workspace), and its action at that line's end, or
 * under it where the column is narrow. When nothing answers them it is the call to connect a plan. Why it is theirs
 * alone is the ⓘ of the section it stands in. Everyone has this row, in the DM's side panel and on the right hand's
 * page.
 */
export function RightHandMineRow({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const connect = useConnectAi();
  const held = usePlanHold() !== null;
  const view = useAgentBrain(org.id, agent.id).data;
  const platform = usePlatformKey(org.id).data === true;
  const status = mineStatus(view, me.user.id, platform);
  if (!status) return null;
  const first = (id: string) => dir.memberById.get(id)?.name.split(" ")[0] ?? "";
  const back = () =>
    void api.agents
      .setBrain(org.id, agent.id, { scope: "mine", brain: "model" })
      .then(() => {
        void qc.invalidateQueries({ queryKey: keys.agentBrain(org.id, agent.id) });
        void qc.invalidateQueries({ queryKey: keys.aiStatus(org.id) });
      })
      .catch((e) => toast.show(errorText(t, e), "error"));
  const connectTo = (label: string, primary = false) =>
    connect && (
      <Button size="sm" variant={primary ? "primary" : undefined} onClick={() => connect.open({ agentId: agent.id })}>
        {label}
      </Button>
    );
  let face: ReactNode;
  let name: string;
  let what: string | null = null;
  let acts: ReactNode;
  if (status.kind === "own") {
    const kind = planKind(status.brain);
    face = kind && <BrainLogo kind={kind} size="sm" />;
    name = status.label ?? (kind ? t(`aiAccounts.connect.${kind}`) : t("rightHand.settings.mine"));
    what = status.ownerId
      ? t("rightHand.settings.mineOf", { owner: first(status.ownerId) })
      : t("rightHand.settings.mineYours");
    acts = (
      <>
        <Button size="sm" onClick={back}>
          {t("rightHand.settings.useWorkspace")}
        </Button>
        {connectTo(t("rightHand.settings.change"))}
      </>
    );
  } else if (status.kind === "key") {
    face = status.provider ? (
      <ProviderLogo id={status.provider} size="sm" />
    ) : (
      <span className="ac-brand ac-brand--sm ac-brand--mono" aria-hidden="true">
        <Icon name="key" />
      </span>
    );
    name = status.label ?? t("rightHand.settings.mineKeyName");
    what = t("rightHand.settings.mineKey");
    acts = connectTo(t("rightHand.settings.useMine"));
  } else if (status.kind === "plan") {
    const kind = planKind(status.brain);
    face = kind && <BrainLogo kind={kind} size="sm" />;
    name = kind ? t(`aiAccounts.connect.${kind}`) : t("rightHand.settings.workspace");
    what = t("rightHand.settings.minePlan");
    acts = connectTo(t("rightHand.settings.useMine"));
  } else {
    face = <Icon name="bulb" size={16} className="muted" />;
    name = t("rightHand.settings.mineNobody");
    // On a billing hold nothing connects before the plan, whose one way in is the hold's banner (ADR 0158).
    if (held) what = t("agentSetup.firstRun.afterPlan");
    else acts = connectTo(t("rightHand.settings.connectMine"), true);
  }
  return (
    <div className="rh-mine ac-mediarow ac-mediarow--row">
      <span className="ac-mediarow__face">{face}</span>
      <span className="ac-mediarow__head">
        <b>{name}</b>
        {what && <span className="ac-mediarow__meta">{what}</span>}
      </span>
      {acts && <span className="ac-mediarow__end ac-mediarow__end--wrap rh-set__acts">{acts}</span>}
    </div>
  );
}

/** "Sua IA"'s explanation, the ⓘ of the section the status stands in. */
export function useRightHandMineHint(agent: Agent) {
  const { t } = useTranslation();
  return {
    name: t("common.about", { label: t("rightHand.settings.mine") }),
    text: t("rightHand.settings.mineHelp", agentGrammar(agent.name)),
  };
}

function RightHandForm({ agent }: { agent: Agent }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const update = useUpdateAgent(org.id, agent.id);
  const models = useModels();
  const credentials = useCredentials(org.id, can(org, "manage_credentials"));
  const platform = usePlatformKey(org.id);
  const [name, setName] = useState(agent.name);
  const [budget, setBudget] = useState(agent.monthlyBudgetUsd == null ? "" : String(agent.monthlyBudgetUsd));
  const [looking, setLooking] = useState(false);
  const [look, setLook] = useState(() => fullLook(lookOf(agent)));
  const g = agentGrammar(agent.name);
  const label = t("rightHand.label");
  const api = useApi();
  const qc = useQueryClient();
  const dir = useDirectory(org.id);
  const hold = usePlanHold();
  // The workspace's AI (ADR 0137 §11): what every DM thinks with while its person has no plan of their own.
  const kind = planKind(agent.brain?.kind);
  const view = useAgentBrain(org.id, agent.id, true, false, "workspace").data;
  const signIn = view?.accounts.find((a) => a.id === view.account);
  const key = view?.workspaceAi?.key;
  const ownerId = signIn?.ownerId;
  const planOwner = ownerId ? dir.memberById.get(ownerId)?.name.split(" ")[0] : undefined;
  const save = (patch: Parameters<typeof update.mutate>[0], onSuccess?: () => void) =>
    update.mutate(patch, { onSuccess, onError: (e) => toast.show(errorText(t, e), "error") });
  const setWorkspace = (input: AgentBrainInput) =>
    void api.agents
      .setBrain(org.id, agent.id, { scope: "workspace", ...input })
      .then(() => {
        for (const key of [keys.agentBrain(org.id, agent.id), keys.agents(org.id), keys.aiStatus(org.id)])
          void qc.invalidateQueries({ queryKey: key });
      })
      .catch((e) => toast.show(errorText(t, e), "error"));
  const rename = () => {
    const next = name.trim();
    if (!next || next === agent.name) return setName(agent.name);
    save({ name: next, handle: handleAfterRename(agent, next) });
  };
  const saveBudget = () => {
    const typed = budget.trim().replace(",", ".");
    const amount = typed === "" ? null : Number(typed);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0))
      return toast.show(t("agent.budgetInvalid"), "error");
    if (amount !== (agent.monthlyBudgetUsd ?? null)) save({ monthlyBudgetUsd: amount });
  };
  const list = modelOptions(
    t,
    i18n.language,
    modelChoices(models.data?.models ?? [], credentials.data ?? [], platform.data ?? false),
  );
  // Plans it may think with for everyone: the admin's own, and everyone's with `use_others_plans`.
  const plans = (view?.accounts ?? []).filter((a) => a.status === "active");
  const firstOf = (id: string | null | undefined) => (id ? dir.memberById.get(id)?.name.split(" ")[0] : undefined);
  const opened = view ? !view.onlyOwner : false;
  return (
    <>
      {hold && (
        <Card className="ai-panel">
          <PlanHold hold={hold} />
        </Card>
      )}
      <Card>
        <div className="settings-rows">
          <PrefRow
            id="rh-name"
            icon="agent"
            label={t("rightHand.settings.name")}
            hint={t("rightHand.settings.nameHelp", { ...g, label })}
            control={
              <span className="rh-set__name">
                <button
                  type="button"
                  className="rh-set__face-edit"
                  aria-label={t("rightHand.settings.lookEdit", g)}
                  title={t("rightHand.settings.lookEdit", g)}
                  onClick={() => setLooking(true)}
                >
                  <AgentAvatar agentId={agent.id} name={agent.name} size="md" />
                </button>
                <Input
                  aria-label={t("rightHand.settings.name")}
                  value={name}
                  maxLength={60}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={rename}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                />
              </span>
            }
          />
          <PrefRow
            id="rh-ai"
            icon="members"
            label={t("rightHand.settings.workspace")}
            hint={t(kind ? "rightHand.settings.planHelp" : "rightHand.settings.workspaceHelp", g)}
            value={
              kind ? (
                <PlanLine kind={kind} label={signIn?.label} owner={ownerId !== me.user.id ? planOwner : undefined} />
              ) : (
                key && (
                  <>
                    <ProviderLogo id={key.provider} size="xs" />
                    <b>{key.label}</b>
                  </>
                )
              )
            }
            control={
              kind ? (
                !hold && (
                  <Button size="sm" onClick={() => setWorkspace({ brain: "model" })}>
                    {t("noAi.rightHand.useKey")}
                  </Button>
                )
              ) : (
                <ModelSelect
                  className="rh-set__model"
                  aria-label={t("rightHand.settings.workspace")}
                  value={agent.model}
                  onChange={(model) => model !== agent.model && save({ model })}
                  options={[
                    { value: AUTO, label: t("brain.auto.label"), description: t("brain.auto.hint") },
                    ...(agent.model === AUTO || list.some((o) => o.value === agent.model)
                      ? []
                      : [{ value: agent.model, label: agent.model }]),
                    ...list,
                  ]}
                />
              )
            }
          />
          {!kind && !hold && (
            <PrefRow
              id="rh-plan"
              icon="plug"
              label={t("rightHand.settings.workspacePlan")}
              hint={plans.length > 0 ? t("rightHand.settings.workspacePlanHelp", g) : undefined}
              status={plans.length > 0 ? undefined : t("rightHand.settings.noPlans", g)}
              control={
                plans.length > 0 && (
                  <Select
                    className="rh-set__model"
                    aria-label={t("rightHand.settings.workspacePlan")}
                    placeholder={t("rightHand.settings.pickPlan")}
                    value={undefined}
                    align="end"
                    onValueChange={(id) => {
                      const a = plans.find((p) => p.id === id);
                      if (a) setWorkspace({ brain: a.kind, account: a.id });
                    }}
                    options={plans.map((a) => ({
                      value: a.id,
                      label:
                        a.ownerId && a.ownerId !== me.user.id ? `${a.label} · ${firstOf(a.ownerId) ?? ""}` : a.label,
                      leading: <BrainLogo kind={a.kind} size="sm" />,
                    }))}
                  />
                )
              }
            />
          )}
          {kind && view && (
            // As for any agent on its owner's plan (ADR 0059 §5): the plan's owner chooses, an admin may override, and
            // the plan's owner hears it by email. For the right hand it decides who without a plan of their own may
            // talk to it on this one.
            <PrefRow
              id="rh-shares"
              icon={opened ? "audienceEveryone" : "audienceOwner"}
              label={t("aiAccounts.share.switch")}
              status={
                <PlanTerms
                  line={t(
                    opened
                      ? "rightHand.settings.sharesOn"
                      : ownerId === me.user.id
                        ? "rightHand.settings.sharesOffYou"
                        : "rightHand.settings.sharesOff",
                    { ...g, owner: planOwner ?? "" },
                  )}
                  brain={kind}
                  plan={signIn?.plan}
                  coding={accountPlan(signIn)}
                />
              }
              control={
                <Switch
                  aria-label={t("aiAccounts.share.switch")}
                  checked={opened}
                  disabled={!view.canEdit}
                  onCheckedChange={(on) => setWorkspace({ onlyOwner: !on })}
                />
              }
            />
          )}
          <PrefRow
            id="rh-budget"
            icon="wallet"
            label={t("rightHand.settings.budget")}
            hint={t("rightHand.settings.budgetHelp", g)}
            control={
              <span className="rh-set__budget">
                <AffixInput
                  aria-label={t("rightHand.settings.budget")}
                  prefix="US$"
                  inputMode="decimal"
                  value={budget}
                  placeholder={t("rightHand.value.budgetDefault")}
                  onChange={(e) => setBudget(e.target.value)}
                  onBlur={saveBudget}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                />
                <span className="muted">{t("rightHand.settings.perMonth")}</span>
              </span>
            }
          />
          <TeamWeekPref name={agent.name} />
        </div>
      </Card>
      <Card aria-labelledby="rh-audience">
        <CardHeader
          id="rh-audience"
          icon="audiencePeople"
          title={t("rightHand.settings.audience")}
          subtitle={t("rightHand.settings.audienceHelp", g)}
        />
        <div className="rh-set__audience">
          <AudienceChoice
            value={audienceOf(agent)}
            onChange={(next) => save({ audience: audiencePatch(next) })}
            ownerUserId={agent.ownerUserId}
            agentName={agent.name}
            idPrefix="rh-audience"
          />
        </div>
        <CardFooter icon="lock">
          {t("rightHand.settings.lock", g)}{" "}
          <Link
            to="/org/$orgId/settings/$section"
            params={{ orgId: org.id, section: "audit" }}
            search={{ agent: agent.id }}
          >
            {t("rightHand.settings.audit", g)}
          </Link>
        </CardFooter>
      </Card>
      <Dialog
        open={looking}
        onOpenChange={setLooking}
        title={t("rightHand.settings.changeLook")}
        closeLabel={t("common.close")}
        width={480}
      >
        <DialogBody>
          <span className="rh-set__face">
            <AgentAvatar name={agent.name} appearance={look} size="lg" />
          </span>
          <LookRows look={look} onChange={setLook} />
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => setLooking(false)}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            loading={update.isPending}
            onClick={() => save({ appearance: look }, () => setLooking(false))}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

/**
 * "Semana da equipe" (ADR 0137 §9): an admin's own day and hour of Lodi's weekly card, every day instead, or off.
 * Anyone else may get it every day ("Resumo do dia").
 */
function TeamWeekPref({ name }: { name: string }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const admin = can(org, "administrator");
  const prefs = useTeamWeekPrefs(org.id).data;
  const set = useSetTeamWeekPrefs(org.id);
  const toast = useToast();
  if (!prefs) return null;
  return (
    <PrefRow
      id="rh-team-week"
      icon="calendar"
      label={t(admin ? "teamWeek.settings.label" : "teamWeek.settings.dayLabel")}
      hint={t(admin ? "teamWeek.settings.help" : "teamWeek.settings.dayHelp", agentGrammar(name))}
      control={
        <span className="rh-set__week">
          <TeamWeekSchedule
            prefs={prefs}
            admin={admin}
            locale={i18n.language}
            onChange={(patch) => set.mutate(patch, { onError: (e) => toast.show(errorText(t, e), "error") })}
          />
        </span>
      }
    />
  );
}
