import { isWaitingHandoff, useBrowserHandoffMutations } from "@agenteschat/client";
import { entryButton, entryKind, entryLine, entryPortrait, entryState } from "@agenteschat/client/lib/agent-computer";
import { computerName } from "@agenteschat/client/lib/computer";
import { Button, ComputerPortrait, Icon, SkyStrip } from "@agenteschat/ui";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { stepText } from "@/components/browser/BrowserCard";
import { useAgentComputer } from "@/components/computer/facts";
import { useOpenComputer } from "@/components/computer/open";
import { useOrg } from "@/components/org-context";
import { colorOf } from "@/components/Sky";
import { useSetupWait, useWaitReader } from "@/components/WorkspaceComputer";
import { useDirectory } from "@/hooks/useDirectory";
import { useNow } from "@/hooks/useNow";
import { useOpenParam } from "@/lib/open-param";
import { useToast } from "@/lib/toast";
import { useAgentEdit } from "./context";
import "@/components/computer/computer.css";

/** Older links to the agent's computer: notifications and the Mac app's tray carry them. */
const OLD_LINKS = ["browser", "desktop", "terminal"] as const;

/**
 * "Desk's computer" at the top of the agent's overview (on its page and in the panel beside its DM): one row,
 * one status line, one button that opens the computer dialog, Help when a request waits for this person.
 * Only for whoever may watch it, the wait included. `?computer=1` opens it (`?browser=1`, `?desktop=1` and
 * `?terminal=1` too: older links). The row never opens a stream.
 */
export function ComputerNow() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const { agent, g, openWork } = useAgentEdit();
  const view = useAgentComputer(agent, { runs: true });
  const openComputer = useOpenComputer();
  const actions = useBrowserHandoffMutations(org.id);
  const [asked, clearAsked] = useOpenParam("computer", OLD_LINKS);
  useEffect(() => {
    if (asked === null) return;
    openComputer(agent.id);
    clearAsked(null);
  }, [asked, clearAsked, openComputer, agent.id]);
  const f = view.facts;
  const reader = useWaitReader();
  const setupWait = useSetupWait(view.setup, reader.held);
  const waiting = Boolean(f?.handoff && isWaitingHandoff(f.handoff));
  // A request's minutes left move on too. While the computer is on its way, the time every other line reads.
  const requestNow = useNow(waiting ? 15_000 : false);
  const now = setupWait.now ?? requestNow;
  // Only for whoever may watch it; nothing while that loads, never one edition's words before the other's.
  if (view.forbidden || !view.ready || !f) return null;
  const state = entryState(f, now);
  const last = view.steps.at(-1);
  const line = entryLine(t, state, {
    edition: f.edition,
    locale: i18n.language,
    computer: computerName(t, org.name, view.machine),
    lastSeenAt: view.machine?.lastSeenAt ?? null,
    person: (id) => dir.memberById.get(id)?.name ?? t("channel.unknownPerson"),
    step: last ? stepText(t, last, last.screen) : null,
    emailPromised: setupWait.email && reader.owner,
    now: new Date(now),
  });
  const button = entryButton(state);
  const help = () => {
    if (state.kind !== "needsYou") return;
    actions.takeControl.mutate(state.handoff.id, {
      onSuccess: () => openComputer(agent.id),
      onError: (err) =>
        toast.show(
          (err as { status?: number }).status === 409 ? t("browser.card.busy") : t("browser.card.openFailed"),
          "error",
        ),
    });
  };
  const tone = state.kind === "needsYou" ? "warn" : state.kind === "needsOther" ? "asked" : undefined;
  return (
    <section className="cmp-entry" data-tone={tone} aria-label={t("agentComputer.title", g)}>
      <SkyStrip color={colorOf(agent)} moving={state.kind === "working"} />
      <div className="cmp-entry__row ac-faceline">
        <ComputerPortrait kind={entryKind(f.edition, view.machine)} state={entryPortrait(state, f.setup)} />
        <span className="cmp-entry__t">
          <b className="ac-captop">{t("agentComputer.title", g)}</b>
          <span className="cmp-entry__line">
            {state.kind === "held" && <Icon name="pause" size={14} />}
            {state.kind === "problem" && <Icon name="alert" size={14} />}
            {state.kind === "needsOther" && <span className="cmp-entry__dot" aria-hidden="true" />}
            <span>{line}</span>
          </span>
        </span>
        {button === "help" ? (
          <Button size="sm" variant="primary" loading={actions.takeControl.isPending} onClick={help}>
            {t("agentComputer.help")}
          </Button>
        ) : button === "choose" ? (
          <Button size="sm" onClick={() => openWork("computer")}>
            {t("agentComputer.choose")}
          </Button>
        ) : (
          <Button size="sm" icon="computer" onClick={() => openComputer(agent.id)}>
            {t("agentComputer.open")}
          </Button>
        )}
      </div>
    </section>
  );
}
