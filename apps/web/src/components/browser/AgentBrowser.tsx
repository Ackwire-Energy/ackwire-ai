import type { Agent, AgentBrowserSettings, BrowserHandoff, LiveRun } from "@agenteschat/client";
import {
  agentStateOfRun,
  BROWSER_TOOL_SCOPE,
  browserSteps,
  controlledBy,
  handoffMinutesLeft,
  isOpenHandoff,
  isWaitingHandoff,
  keys,
  useAgentBrowserSettings,
  useApi,
  useBrowserHandoffMutations,
  useMachines,
  usesBrowser,
} from "@agenteschat/client";
import { computerName } from "@agenteschat/client/lib/computer";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { can } from "@agenteschat/client/lib/permissions";
import { Button, Dialog, DialogBody, Icon } from "@agenteschat/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { useStreams } from "@/realtime/context";
import { useOrg } from "../org-context";
import { BrowserCard } from "./BrowserCard";
import { useTick } from "./BrowserHandoffCard";
import "./browser.css";

/** Outside the agent's conversations no event says when its request changes: it's asked again this often. */
const HANDOFF_POLL_MS = 30_000;

/**
 * The agent's browser settings when this person gets its browser outside a conversation: admins and
 * its owner (the server's rule; whoever a request went to, or who started a run going on now, gets it
 * where that happens), once the agent may use its browser and its computer serves it. Null otherwise.
 */
export function useAgentBrowserReady(agent: Pick<Agent, "id" | "ownerUserId">): AgentBrowserSettings | null {
  const { org, me } = useOrg();
  const api = useApi();
  const allowed = can(org.role, "manage_agents") || agent.ownerUserId === me.user.id;
  const settings = useAgentBrowserSettings(org.id, agent.id, allowed);
  const scopes = useQuery({
    queryKey: keys.scopes(org.id, agent.id),
    queryFn: () => api.scopes.get(org.id, agent.id),
    enabled: allowed,
    retry: false,
  });
  const granted = (scopes.data ?? []).some((s) => s.connectionId === null && s.scope === BROWSER_TOOL_SCOPE);
  return allowed && granted && settings.data?.available ? settings.data : null;
}

/** The agent's open request or take over, if any. */
function useOpenHandoff(agentId: string, enabled: boolean): BrowserHandoff | null {
  const { org } = useOrg();
  const api = useApi();
  const q = useQuery({
    queryKey: keys.agentBrowserHandoff(org.id, agentId),
    queryFn: () => api.browser.agentHandoff(org.id, agentId),
    enabled,
    retry: false,
    refetchInterval: HANDOFF_POLL_MS,
  });
  return q.data && isOpenHandoff(q.data) ? q.data : null;
}

/** The agent's run at work in its browser now, among the conversations this tab listens to. */
function useBrowsingRun(agentId: string): LiveRun | undefined {
  const runId = useStreams(
    (s) =>
      Object.values(s.runs).find((r) => r.agentId === agentId && agentStateOfRun(r) !== "idle" && usesBrowser(r))
        ?.runId ?? "",
  );
  return useStreams((s) => (runId ? s.runs[runId] : undefined));
}

/**
 * The agent's browser now, on its page and in its dialog: a request waiting for someone (amber,
 * Abrir), someone else in control (who; the page stays hidden from everyone else), the agent at work
 * in it (its live card), or nothing going on: where it runs, and Abrir o navegador, straight into
 * control (to sign in ahead of time). No picture of an idle browser: watching would keep it open.
 */
export function AgentBrowserNow({
  agent,
  settings,
  viewing,
  onView,
  dialog = false,
}: {
  agent: Agent;
  settings: AgentBrowserSettings;
  /** The card is open on request (Ver, Abrir, `?browser=1`). */
  viewing: boolean;
  onView: (on: boolean) => void;
  /** In a dialog of its own: the card is always there, open. */
  dialog?: boolean;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const machines = useMachines(org.id);
  const actions = useBrowserHandoffMutations(org.id);
  const handoff = useOpenHandoff(agent.id, true);
  const run = useBrowsingRun(agent.id);
  const g = agentGrammar(t, agent.name);
  const mine = controlledBy(handoff, me.user.id);
  const waiting = handoff !== null && isWaitingHandoff(handoff);
  useTick(waiting);
  const minutes = waiting && handoff ? handoffMinutesLeft(handoff) : null;
  const controller = handoff?.status === "active" && !mine ? handoff.controllerUserId : null;
  const refused = (err: unknown) =>
    toast.show(
      (err as { status?: number }).status === 409 ? t("browser.card.busy") : t("browser.card.openFailed"),
      "error",
    );
  const take = (id: string) => actions.takeControl.mutate(id, { onSuccess: () => onView(true), onError: refused });
  const openBrowser = () => actions.takeover.mutate(agent.id, { onSuccess: () => onView(true), onError: refused });
  const card = dialog || viewing || mine || Boolean(run);
  return (
    <section className="brw-now" aria-label={t("browser.inCard.group", g)}>
      {waiting && handoff && (
        <div className="brw-now__row" data-tone="warn">
          <span className="brw-now__ic">
            <Icon name="globe" size={16} />
          </span>
          <span className="brw-now__t">
            <b>{t("browser.now.needsYou", g)}</b>
            <span>
              {handoff.instructions}
              {minutes !== null && ` · ${t("browser.card.leftShort", { count: minutes })}`}
            </span>
          </span>
          <Button
            size="sm"
            variant="primary"
            icon="globe"
            loading={actions.takeControl.isPending}
            onClick={() => take(handoff.id)}
          >
            {t("browser.card.open")}
          </Button>
        </div>
      )}
      {card ? (
        <BrowserCard
          agentId={agent.id}
          name={agent.name}
          steps={browserSteps(run?.work)}
          runId={run?.runId}
          place={run ? { channelId: run.channelId, threadId: run.threadId } : undefined}
          handoff={handoff}
          defaultOpen={dialog || viewing || mine}
          fixedOpen={dialog}
          // A run's card folds to its small form; one opened on request goes away.
          onFold={dialog || run ? undefined : () => onView(false)}
          onSettled={() => onView(false)}
        />
      ) : controller ? (
        // Nothing to watch: their screen stays theirs until they hand it back.
        <div className="brw-now__row">
          <span className="brw-now__ic">
            <Icon name="person" size={16} />
          </span>
          <span className="brw-now__t">
            <b>
              {t("browser.live.otherInControl", {
                name: dir.memberById.get(controller)?.name ?? t("channel.unknownPerson"),
              })}
            </b>
            <span>{handoff?.kind === "ask" ? handoff.instructions : t("browser.now.tookOver", g)}</span>
          </span>
        </div>
      ) : (
        !waiting && (
          <div className="brw-now__row">
            <span className="brw-now__ic">
              <Icon name="globe" size={16} />
            </span>
            <span className="brw-now__t">
              <b>{t("browser.inCard.group", g)}</b>
              <span>
                {settings.machine
                  ? t("browser.now.ready", {
                      computer: computerName(
                        t,
                        machines.data?.find((m) => m.id === settings.machine?.id) ?? settings.machine,
                        org.name,
                      ),
                    })
                  : t("browser.machine.ready")}
              </span>
            </span>
            <Button size="sm" icon="globe" loading={actions.takeover.isPending} onClick={openBrowser}>
              {t("browser.inCard.openBrowser")}
            </Button>
          </div>
        )
      )}
    </section>
  );
}

/**
 * "Navegador" in the agent's DM header: its browser now, in a dialog of its own, with a dot while the
 * agent is in its browser (amber while a request waits for someone). In control, Esc goes to the page;
 * closing the dialog hands a take over back at once instead of after the 2-minute grace. The agent's own
 * request ends only with Pronto or Desistir: closing keeps it (the grace), so the person can carry on.
 */
export function AgentBrowserButton({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const actions = useBrowserHandoffMutations(org.id);
  const settings = useAgentBrowserReady(agent);
  const handoff = useOpenHandoff(agent.id, settings !== null);
  const run = useBrowsingRun(agent.id);
  const [shown, setShown] = useState(false);
  if (!settings) return null;
  const g = agentGrammar(t, agent.name);
  const mine = controlledBy(handoff, me.user.id);
  const state =
    handoff && isWaitingHandoff(handoff) ? "waiting" : run || handoff?.status === "active" ? "live" : undefined;
  const close = () => {
    setShown(false);
    if (!mine || handoff?.kind !== "takeover") return;
    actions.done.mutate(handoff.id, {
      onSuccess: () => toast.show(t("browser.now.handedBack", g)),
      onError: () => toast.show(t("browser.live.actionFailed"), "error"),
    });
  };
  return (
    <>
      <Button size="sm" icon="globe" className="brw-dm" data-state={state} onClick={() => setShown(true)}>
        <span className="brw-dm__label">{t("browser.title")}</span>
        {state && (
          <span className="ac-visually-hidden">
            {state === "waiting" ? t("browser.machine.waitingChip") : t("browser.watch.title")}
          </span>
        )}
      </Button>
      <Dialog
        open={shown}
        onOpenChange={(next) => (next ? setShown(true) : close())}
        title={t("browser.inCard.group", g)}
        closeLabel={t("common.close")}
        width={760}
        className="brw-dialog"
        // In control the page takes Esc; in full screen Esc leaves full screen first.
        onEscapeKeyDown={(e) => {
          if (mine || document.querySelector(".brw-ac.is-full")) e.preventDefault();
        }}
      >
        <DialogBody>
          <AgentBrowserNow agent={agent} settings={settings} viewing onView={() => {}} dialog />
        </DialogBody>
      </Dialog>
    </>
  );
}
