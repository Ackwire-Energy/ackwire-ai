import type { ConnectIntent, MachineAccount, MachineAccountKind } from "@agenteschat/client";
import { keys, useAgentBrain, useApi } from "@agenteschat/client";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { PLAN_BRAIN } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import {
  BrainLogo,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  Icon,
  OptionCard,
  Select,
  SettingNote,
  Spinner,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { AddAccount } from "@/pages/agent/Work";
import { KeyDialog } from "@/pages/SettingsPage";
import "./no-ai.css";

/*
 * "Conectar uma IA" (ADR 0057): one dialog for every place that says an agent has no AI (the banner,
 * the agent's card, the receipt under a message, its "Sem IA" chip). Its first step offers a Claude or
 * ChatGPT plan, thinking on the agent's computer, or an API key; a message that asked for one of them
 * opens at that step. Connected from a card or a message, the agent then answers it by itself.
 */

type PlanStep = "claude" | "chatgpt";
type Step = "any" | PlanStep | "api_key";

const stepFor = (intent: ConnectIntent | undefined): Step =>
  intent === "claude" || intent === "chatgpt" || intent === "api_key" ? intent : "any";

export interface ConnectAiRequest {
  /** The step the message asked for (Jev); `any`, `task` or none: the first step. */
  intent?: ConnectIntent;
  /** With `api_key`: the provider it named. */
  provider?: string;
  /** The agent to connect: a plan changes who thinks for it. */
  agentId?: string;
  /** The agents to choose from (an agent's card names them); `agentId` is shown first. */
  agentIds?: string[];
  /** The no-AI card or the person's message: once connected, it is answered ("Responder agora"). */
  from?: string;
  /** A key pasted in the composer. */
  apiKey?: string;
  /** Opened by itself (Jev), not by a click: never over a dialog already open. */
  auto?: boolean;
}

/** How "Responder agora" went for a message, in this tab. */
export type AnswerState = "pending" | "answering" | "still_missing";

export interface ConnectAi {
  open(request: ConnectAiRequest): void;
  /** "Responder agora" (`from`: the no-AI card or the person's message). */
  answer(from: string): Promise<void>;
  answered: Record<string, AnswerState>;
}

const ConnectAiContext = createContext<ConnectAi | null>(null);

/** Null outside the workspace shell (an isolated page in a test): no Connect there. */
export const useConnectAi = () => useContext(ConnectAiContext);

export function ConnectAiProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const toast = useToast();
  const [request, setRequest] = useState<(ConnectAiRequest & { step: Step }) | null>(null);
  const [answered, setAnswered] = useState<Record<string, AnswerState>>({});
  const open = useCallback((next: ConnectAiRequest) => {
    setRequest((current) => (current && next.auto ? current : { ...next, step: stepFor(next.intent) }));
  }, []);
  const answer = useCallback(
    async (from: string) => {
      setAnswered((a) => ({ ...a, [from]: "pending" }));
      try {
        await api.chat.answerNow(org.id, from);
        setAnswered((a) => ({ ...a, [from]: "answering" }));
      } catch (error) {
        const missing = errorCode(error) === "ai.still_missing";
        setAnswered((a) => {
          const { [from]: _pending, ...rest } = a;
          return missing ? { ...rest, [from]: "still_missing" } : rest;
        });
        if (!missing) toast.show(errorText(t, error), "error");
      }
    },
    [api, org.id, toast, t],
  );
  const value = useMemo(() => ({ open, answer, answered }), [open, answer, answered]);
  return (
    <ConnectAiContext.Provider value={value}>
      {children}
      {request && (
        <ConnectAiDialog
          request={request}
          onStep={(step) => setRequest((r) => r && { ...r, step })}
          onClose={() => setRequest(null)}
          onConnected={() => {
            if (request.from) void answer(request.from);
          }}
        />
      )}
    </ConnectAiContext.Provider>
  );
}

function ConnectAiDialog({
  request,
  onStep,
  onClose,
  onConnected,
}: {
  request: ConnectAiRequest & { step: Step };
  onStep: (step: Step) => void;
  onClose: () => void;
  onConnected: () => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const qc = useQueryClient();
  // An API key is the organization's (admins); a plan changes who thinks for an agent (its owner or an admin).
  const mayAddKey = can(org.role, "manage_credentials");
  const editable = dir.agents.filter((a) => can(org.role, "manage_agents") || a.ownerUserId === me.user.id);
  const named = request.agentIds?.length ? request.agentIds : request.agentId ? [request.agentId] : null;
  const agents = named ? editable.filter((a) => named.includes(a.id)) : editable;
  const plans = agents.length > 0;
  const step =
    request.step === "api_key"
      ? mayAddKey
        ? "api_key"
        : "any"
      : request.step !== "any" && !plans
        ? "any"
        : request.step;
  const connected = () => {
    void qc.invalidateQueries({ queryKey: keys.aiStatus(org.id) });
    onConnected();
  };

  if (step === "api_key") {
    return (
      <KeyDialog
        mode="add"
        cred={undefined}
        provider={request.provider}
        apiKey={request.apiKey}
        title={t("connectAi.title.api_key")}
        onAdded={connected}
        onClose={onClose}
      />
    );
  }
  if (step !== "any") {
    return (
      <PlanDialog
        step={step}
        agents={agents.map((a) => ({ id: a.id, name: a.name }))}
        firstId={request.agentId}
        onKey={mayAddKey ? () => onStep("api_key") : undefined}
        onBack={() => onStep("any")}
        onClose={onClose}
        onConnected={() => {
          connected();
          onClose();
        }}
      />
    );
  }
  const agent = request.agentId ? dir.agentById.get(request.agentId) : undefined;
  const owner = agent?.ownerUserId ? dir.memberById.get(agent.ownerUserId)?.name : undefined;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("connectAi.title.any")}
      closeLabel={t("common.close")}
      width={480}
    >
      <DialogBody>
        {mayAddKey || plans ? (
          <div className="connect-ai__options">
            {plans &&
              (["claude", "chatgpt"] as const).map((k) => (
                <OptionCard key={k} pressed={false} onClick={() => onStep(k)}>
                  <BrainLogo kind={PLAN_BRAIN[k]} size="sm" />
                  <span className="ac-option__text">
                    <span className="ac-option__title">{t(`connectAi.option.${k}`)}</span>
                    <span className="ac-option__desc">{t(`connectAi.option.${k}Desc`)}</span>
                  </span>
                </OptionCard>
              ))}
            {mayAddKey ? (
              <OptionCard pressed={false} onClick={() => onStep("api_key")}>
                <span className="connect-ai__key" aria-hidden="true">
                  <Icon name="key" size={16} />
                </span>
                <span className="ac-option__text">
                  <span className="ac-option__title">{t("connectAi.option.api_key")}</span>
                  <span className="ac-option__desc">{t("connectAi.option.api_keyDesc")}</span>
                </span>
              </OptionCard>
            ) : (
              <SettingNote icon="lock">{t("connectAi.keyLocked")}</SettingNote>
            )}
          </div>
        ) : (
          <SettingNote icon="lock">
            {agent && owner
              ? t("noAi.locked", { name: agent.name, owner: owner.split(" ")[0] })
              : t("noAi.lockedAdmins")}
          </SettingNote>
        )}
      </DialogBody>
    </Dialog>
  );
}

/**
 * A Claude or ChatGPT plan for one agent: signed in on the agent's computer (the provider's own sign-in,
 * ADR 0041), then "Usar meu plano" makes it the agent's brain (the person confirms the plan warning).
 */
function PlanDialog({
  step,
  agents,
  firstId,
  onKey,
  onBack,
  onClose,
  onConnected,
}: {
  step: PlanStep;
  agents: { id: string; name: string }[];
  firstId?: string;
  onKey?: () => void;
  onBack: () => void;
  onClose: () => void;
  onConnected: () => void;
}) {
  const { t } = useTranslation();
  const [agentId, setAgentId] = useState(() => agents.find((a) => a.id === firstId)?.id ?? agents[0]?.id ?? "");
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t(`connectAi.title.${step}`)}
      closeLabel={t("common.close")}
      width={520}
    >
      <PlanForAgent
        key={agentId}
        kind={PLAN_BRAIN[step]}
        agentId={agentId}
        picker={
          agents.length > 1 && (
            <Select
              aria-label={t("connectAi.agent")}
              value={agentId}
              onValueChange={setAgentId}
              options={agents.map((a) => ({ value: a.id, label: a.name }))}
            />
          )
        }
        onKey={onKey}
        onBack={onBack}
        onClose={onClose}
        onConnected={onConnected}
      />
    </Dialog>
  );
}

function PlanForAgent({
  kind,
  agentId,
  picker,
  onKey,
  onBack,
  onClose,
  onConnected,
}: {
  kind: MachineAccountKind;
  agentId: string;
  /** Which agent, when there are several. */
  picker: ReactNode;
  onKey?: () => void;
  onBack: () => void;
  onClose: () => void;
  onConnected: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const brain = useAgentBrain(org.id, agentId);
  const [added, setAdded] = useState<MachineAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const view = brain.data;
  if (!view) {
    return (
      <DialogBody>
        {picker}
        {brain.isError ? <SettingNote icon="alert">{t("common.loadFailed")}</SettingNote> : <Spinner />}
      </DialogBody>
    );
  }
  const computer = view.computer;
  const option = view.options.find((o) => o.kind === kind);
  // What keeps the plan from this agent's computer right now; the sign-in otherwise.
  const blocked = !computer
    ? t("connectAi.waitComputer")
    : !computer.online
      ? t("brain.offline", { computer: computer.name })
      : !option?.available
        ? t(`brain.reasons.${option?.reason ?? "not_installed"}`, { computer: computer.name })
        : !view.accountsSupported
          ? t("brain.reasons.runner_old")
          : !view.canManageAccounts
            ? t("connectAi.accountsLocked", {
                name: view.accountsOwner?.name.split(" ")[0] ?? "",
                computer: computer.name,
              })
            : null;
  if (blocked || !computer) {
    return (
      <>
        <DialogBody>
          {picker}
          <SettingNote icon="alert">{blocked}</SettingNote>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onBack}>{t("common.back")}</Button>
          {onKey && (
            <Button variant="primary" icon="key" onClick={onKey}>
              {t("connectAi.option.api_key")}
            </Button>
          )}
        </DialogFooter>
      </>
    );
  }
  const current = view.accounts.find((a) => a.id === view.account && a.kind === kind);
  const use = async () => {
    if (!added) return;
    setBusy(true);
    try {
      await api.agents.setBrain(org.id, agentId, { brain: kind, acceptPlanTerms: true, account: added.id });
      for (const key of [keys.agentBrain(org.id, agentId), keys.agents(org.id), keys.machines(org.id)])
        void qc.invalidateQueries({ queryKey: key });
      onConnected();
    } catch (error) {
      toast.show(errorText(t, error), "error");
      setBusy(false);
    }
  };
  return (
    <>
      <DialogBody>
        {picker}
        <SettingNote icon="alert">
          <Trans i18nKey={`agentPage.work.planNote.${kind}`} components={{ b: <b /> }} />
        </SettingNote>
        {added ? (
          <SettingNote icon="check" live>
            {t("agentPage.work.brain.add.done", { account: added.label, computer: computer.name })}
          </SettingNote>
        ) : (
          <AddAccount
            machineId={computer.machineId}
            kind={kind}
            computer={computer.name}
            again={current?.status === "signed_out" ? current.id : undefined}
            onBack={onBack}
            onAdded={setAdded}
          />
        )}
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" disabled={!added} loading={busy} onClick={() => void use()}>
          {t(`agentPage.work.usePlan.${kind}`)}
        </Button>
      </DialogFooter>
    </>
  );
}
