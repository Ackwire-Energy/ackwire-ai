import type { ConnectIntent } from "@agenteschat/client";
import { keys, useAddCredential, useAiStatus, useApi } from "@agenteschat/client";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { type AiChoice, aiStateOf, defaultChoice, firstAgent, gateDims } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { providerGuess, providerLabel } from "@agenteschat/client/lib/providers";
import { Button, Dialog, DialogBody, DialogFooter, Spinner } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AiPicker, type KeyDraft, KeyPanel, PlanPanel, usePlanGates } from "@/components/ai/ConnectAiSteps";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useOpenParam } from "@/lib/open-param";
import { useToast } from "@/lib/toast";
import "./no-ai.css";

/*
 * "Conectar uma IA" (ADR 0061): one dialog for every place that says an agent has no AI (the banner, the agent's
 * card, the receipt under a message, its "Sem IA" chip, Settings › Contas de IA). The same picker as the setup's AI
 * step: the plans first (Claude chosen), each signing in on the agent's computer, then the workspace's API key; a
 * message that asked for one of them opens on it. Connected from a card or a message, the agent then answers it
 * by itself.
 */

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
    open({});
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
  const named = request.agentIds?.length ? request.agentIds : request.agentId ? [request.agentId] : null;
  const agents = (named ? mine.filter((a) => named.includes(a.id)) : mine).map((a) => ({ id: a.id, name: a.name }));
  // The agents a plan was connected for here: they think with it before the AI status says so.
  const [linked, setLinked] = useState<string[]>([]);
  const hasAi = (id: string) => linked.includes(id) || (aiStateOf(status.data, id) ?? "no_ai") !== "no_ai";
  // Only a pick is kept; else the first agent is worked out on each render (a link opens this before the agents load).
  const [pickedAgent, setPickedAgent] = useState<string>();
  const agentId = pickedAgent ?? firstAgent(agents, hasAi, request.agentId)?.id;
  const gates = usePlanGates(org.id, agentId);
  const [picked, setPicked] = useState<AiChoice | null>(null);
  const choice =
    picked ??
    defaultChoice({
      intent: request.intent,
      ownsAgents: agents.length > 0,
      mayAddKey,
      claudeGate: agentId ? gates.gateOf("claude") : { state: "loading" },
    });
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

  // Opened for one agent: its name in the title, and no agent to choose.
  const one = named?.length === 1 ? dir.agentById.get(named[0] ?? "") : undefined;
  // No agent of theirs among those: who connects a plan instead.
  const owner = one?.ownerUserId ? dir.memberById.get(one.ownerUserId)?.name : undefined;
  const locked =
    agents.length > 0
      ? undefined
      : !named
        ? t("connectAi.noAgents")
        : one && owner
          ? t("noAi.locked", { name: one.name, owner: owner.split(" ")[0] })
          : t("noAi.lockedAdmins");
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={one ? t("connectAi.titleFor", agentGrammar(t, one.name)) : t("connectAi.title.any")}
      closeLabel={t("common.close")}
      // Three plans a row, each name on one line even when chosen, as in the setup's column.
      width={600}
    >
      <DialogBody>
        {/* A link opens this before the agents and their AI load, and what it opens on follows them. */}
        {dir.loading || status.isPending ? (
          <Spinner />
        ) : (
          <>
            <AiPicker
              choice={choice}
              onPick={(next) => {
                setPicked(next);
                // Another plan moves on to the next agent with no AI once this one thinks with a plan from here.
                if (next !== "key" && next !== choice && agentId !== undefined && linked.includes(agentId))
                  setPickedAgent(firstAgent(agents, hasAi)?.id);
              }}
              dims={(c) => agentId !== undefined && gateDims(gates.gateOf(c))}
            />
            {choice === "key" ? (
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
                agents={agents}
                agentId={agentId}
                onAgent={setPickedAgent}
                locked={locked}
                onKey={() => setPicked("key")}
                onComputer={() => {
                  onClose();
                  void navigate({
                    to: "/org/$orgId/settings/$section",
                    params: { orgId: org.id, section: "computers" },
                  });
                }}
                onDone={(id) => {
                  // The panel stays on that agent, saying it's done.
                  setPickedAgent(id);
                  setLinked((l) => [...l, id]);
                  done();
                }}
              />
            )}
          </>
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
