import type { ConnectIntent } from "@agenteschat/client";
import { keys, useAddCredential, useAiStatus, useApi, useCredentials, useMachines } from "@agenteschat/client";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  type AgentAi,
  type AiChoice,
  agentAi,
  aiStateOf,
  allAgents,
  defaultChoice,
  defaultTarget,
  type ExistingSignIn,
  gateDims,
  type PlanChoice,
} from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { providerGuess, providerLabel } from "@agenteschat/client/lib/providers";
import { Button, Dialog, DialogBody, DialogFooter, Spinner } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AiPicker,
  ExistingRows,
  ExistingThinks,
  type ExistingUsed,
  type KeyDraft,
  KeyPanel,
  PlanPanel,
  usePlanGates,
} from "@/components/ai/ConnectAiSteps";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { lookOf } from "@/lib/look";
import { useOpenParam } from "@/lib/open-param";
import { useToast } from "@/lib/toast";
import "./no-ai.css";

/*
 * "Conectar uma IA" (ADR 0061): one dialog for every place that says an agent has no AI (the banner, the agent's
 * card, the receipt under a message, its "Sem IA" chip, Settings › Contas de IA). The same picker as the setup's AI
 * step: the plans first (Claude chosen), each signing in on the agent's computer, then the workspace's API key; a
 * message that asked for one of them opens on it. For one agent with no AI, what the person already has comes before
 * them (`ExistingRows`). Connected from a card or a message, the agent then answers it by itself.
 */

export interface ConnectAiRequest {
  /** The step the message asked for (Jev); `any`, `task` or none: the first step. */
  intent?: ConnectIntent;
  /** The plan it opens on, over `intent`: a card's Sign in again, on the agent's own plan (a coding plan's too). */
  plan?: PlanChoice;
  /** With `api_key`: the provider it named. */
  provider?: string;
  /** The agent to connect: the dialog is for it alone. */
  agentId?: string;
  /** The agents to choose from (an agent's card names them); `agentId` is chosen first. */
  agentIds?: string[];
  /** The no-AI card or the person's message: once connected, it is answered ("Responder agora"). */
  from?: string;
  /** A key pasted in the composer. */
  apiKey?: string;
  /** Opened by itself (Jev), not by a click: never over a dialog already open. */
  auto?: boolean;
  /** Opened because the workspace's computer just got ready (its email, its notification): a plan's panel says so. */
  ready?: boolean;
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
  // Each opening is its own dialog (`n`): what was chosen in another one doesn't carry over.
  const [request, setRequest] = useState<(ConnectAiRequest & { n: number }) | null>(null);
  const [answered, setAnswered] = useState<Record<string, AnswerState>>({});
  const open = useCallback((next: ConnectAiRequest) => {
    setRequest((current) => (current && next.auto ? current : { ...next, n: (current?.n ?? 0) + 1 }));
  }, []);
  // A link that asks for it (the computer ready email's "Connect your AI"): open once, then drop it from the address.
  const [asked, clearAsked] = useOpenParam("connect");
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per link
  useEffect(() => {
    if (asked !== "ai") return;
    open({ ready: true });
    clearAsked(null);
  }, [asked]);
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
          key={request.n}
          request={request}
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
  onClose,
  onConnected,
}: {
  request: ConnectAiRequest;
  onClose: () => void;
  onConnected: () => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const status = useAiStatus(org.id);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const add = useAddCredential(org.id);
  // An API key is the organization's (admins); a plan thinks only for its owner's agents (ADR 0059 §3).
  const mayAddKey = can(org.role, "manage_credentials");
  const mine = dir.agents.filter((a) => a.ownerUserId === me.user.id);
  // An agent's card names whom to choose from. Opened for one agent, it is for that agent alone: the title names it,
  // so no For offers another. Anywhere else every agent of the viewer's stays a choice.
  const named = request.agentIds?.length ? request.agentIds : null;
  const only = named ? (named.length === 1 ? named[0] : undefined) : request.agentId;
  const one = only ? dir.agentById.get(only) : undefined;
  const pool = one ? [one.id] : named;
  const agents = (pool ? mine.filter((a) => pool.includes(a.id)) : mine).map((a) => ({
    id: a.id,
    name: a.name,
    appearance: lookOf(a),
    initials: dir.agentInitials(a.id),
  }));
  const machines = useMachines(org.id);
  // The agents a plan or a key was connected for here: they think with it before the AI status says so.
  const [linked, setLinked] = useState<Record<string, AiChoice>>({});
  const aiOf = (id: string): AgentAi => linked[id] ?? agentAi(dir.agentById.get(id), aiStateOf(status.data, id));
  const hasAi = (id: string) => aiOf(id) !== null;
  // By the AI status, as its "Sem IA" chip: an agent on a plan whose sign-in is gone has none either.
  const noAi = (id: string) => !linked[id] && (aiStateOf(status.data, id) ?? "no_ai") === "no_ai";
  const machineOf = (id: string) => machines.data?.find((m) => m.agents.some((a) => a.id === id))?.id;
  const setOf = (c: AiChoice) => (c === "key" ? [] : allAgents({ choice: c, agents, aiOf, machineOf }));
  // Only a pick is kept; else whom it's for is worked out on each render (a link opens this before the agents load).
  const [pickedTarget, setPickedTarget] = useState<string>();
  // Held once a sign-in starts (`onStart`): every move it makes gives an agent an AI, which would move the default.
  const [heldReader, setHeldReader] = useState<string>();
  const aimed = { agents, hasAi, asked: request.agentId, picked: pickedTarget };
  // With no set, the agent whose computer the panel reads, "All agents" too (they're on that one's computer).
  const reader = heldReader ?? defaultTarget({ ...aimed, set: [] });
  const theirs = one !== undefined && one.ownerUserId !== me.user.id;
  // The one agent the dialog is for: what the person already has comes first for it while it has no AI. An admin sees
  // the accounts of someone else's agent, locked, and may give it a workspace key (ADR 0041 §4).
  const mayUseKeys = can(org.role, "manage_agents");
  const forId = one?.id ?? (agents.length === 1 ? agents[0]?.id : undefined);
  const forAgent = forId ? { id: forId, name: dir.agentById.get(forId)?.name ?? "" } : undefined;
  const gates = usePlanGates(org.id, reader ?? (theirs && mayUseKeys ? one?.id : undefined));
  const credentials = useCredentials(org.id, mayUseKeys && forId !== undefined);
  const [used, setUsed] = useState<ExistingUsed | null>(null);
  const [login, setLogin] = useState<ExistingSignIn | null>(null);
  const [picked, setPicked] = useState<AiChoice | null>(null);
  const choice =
    picked ??
    request.plan ??
    defaultChoice({
      intent: request.intent,
      ownsAgents: agents.length > 0,
      mayAddKey,
      claudeGate: agents.length > 0 ? gates.gateOf("claude") : { state: "loading" },
    });
  const all = setOf(choice).map((a) => ({ ...a, done: aiOf(a.id) === choice }));
  const target = defaultTarget({ ...aimed, set: all });
  const [draft, setDraft] = useState<KeyDraft>(() => ({
    provider: providerGuess(request.apiKey, request.provider),
    apiKey: request.apiKey ?? "",
  }));
  // Anything connected shows Done; only a saved key closes the key's field (after a plan, it's for the other agents).
  const [connected, setConnected] = useState(false);
  const [keySaved, setKeySaved] = useState(false);
  const done = () => {
    setConnected(true);
    void qc.invalidateQueries({ queryKey: keys.aiStatus(org.id) });
    onConnected();
  };
  const saveKey = () => {
    if (draft.provider === "platform") return;
    add.mutate(
      { provider: draft.provider, label: providerLabel(draft.provider), apiKey: draft.apiKey.trim() },
      {
        onSuccess: () => {
          setKeySaved(true);
          done();
        },
      },
    );
  };

  // Someone else's agent, or no agent of theirs among those: who connects a plan instead.
  const owner = one?.ownerUserId ? dir.memberById.get(one.ownerUserId)?.name : undefined;
  const locked = theirs
    ? owner
      ? t("noAi.locked", { name: one.name, owner: owner.split(" ")[0] })
      : t("noAi.lockedAdmins")
    : agents.length > 0
      ? undefined
      : named
        ? t("noAi.lockedAdmins")
        : t("connectAi.noAgents");
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={
        one && (theirs || target === one.id)
          ? t("connectAi.titleFor", agentGrammar(t, one.name))
          : t("connectAi.title.any")
      }
      closeLabel={t("common.close")}
      // Three plans a row, each name on one line even when chosen, as in the setup's column.
      width={600}
    >
      <DialogBody>
        {/* A link opens this before the agents and their AI load, and what it opens on follows them. */}
        {dir.loading || status.isPending ? (
          <Spinner />
        ) : used && forAgent ? (
          <ExistingThinks agent={forAgent} used={used} />
        ) : (
          <AiPicker
            choice={login ? null : choice}
            // Kept while a row's sign-in is open: its panel, under that row, says when it's done.
            have={(held) =>
              forAgent &&
              (login || noAi(forAgent.id)) && (
                <ExistingRows
                  gates={gates}
                  agent={forAgent}
                  credentials={credentials.data ?? []}
                  named={!one}
                  signIn={login}
                  panel={held}
                  onSignIn={(next) => {
                    setLogin(next);
                    setPicked(next.choice);
                    setPickedTarget(forAgent.id);
                    setHeldReader(undefined);
                  }}
                  onUsed={(id, next) => {
                    setLinked((l) => ({ ...l, [id]: next.choice }));
                    setUsed(next);
                    done();
                  }}
                />
              )
            }
            onPick={(next) => {
              setPicked(next);
              setLogin(null);
              if (next === choice) return;
              setHeldReader(undefined);
              // Another plan moves on to whoever still has no AI once this one's agents think with a plan from here.
              if (next !== "key" && Object.keys(linked).length > 0)
                setPickedTarget(defaultTarget({ agents, hasAi, set: setOf(next) }));
            }}
            dims={(c) => agents.length > 0 && gateDims(gates.gateOf(c))}
            panel={
              choice === "key" ? (
                <KeyPanel
                  draft={draft}
                  onDraft={setDraft}
                  locked={!mayAddKey}
                  saved={keySaved}
                  saving={add.isPending}
                  onSave={saveKey}
                />
              ) : (
                <PlanPanel
                  key={choice}
                  choice={choice}
                  gates={gates}
                  justReady={request.ready}
                  agents={agents}
                  all={all}
                  target={target}
                  onTarget={(next) => {
                    setPickedTarget(next);
                    setHeldReader(undefined);
                  }}
                  onStart={() => {
                    setPickedTarget(target);
                    setHeldReader(reader);
                  }}
                  locked={locked}
                  {...(login?.choice === choice ? { login } : {})}
                  onKey={() => {
                    setPicked("key");
                    setLogin(null);
                  }}
                  onComputer={() => {
                    onClose();
                    void navigate({
                      to: "/org/$orgId/settings/$section",
                      params: { orgId: org.id, section: "computers" },
                    });
                  }}
                  onDone={(ids) => {
                    // The panel stays on whom it was for, saying it's done.
                    setPickedTarget(target);
                    setLinked((l) => ({ ...l, ...Object.fromEntries(ids.map((id) => [id, choice])) }));
                    done();
                  }}
                />
              )
            }
          />
        )}
      </DialogBody>
      {connected && (
        <DialogFooter>
          <Button variant="primary" onClick={onClose}>
            {t("connectAi.done")}
          </Button>
        </DialogFooter>
      )}
    </Dialog>
  );
}
