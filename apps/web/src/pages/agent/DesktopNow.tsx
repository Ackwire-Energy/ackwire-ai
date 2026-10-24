import { isWaitingHandoff, useBrowserHandoffMutations, useDesktopStatus } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Button, Icon } from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DesktopView } from "@/components/desktop/DesktopView";
import { useOrg } from "@/components/org-context";
import { useOpenParam } from "@/lib/open-param";
import { useToast } from "@/lib/toast";
import { useAgentEdit } from "./context";

/**
 * The agent's desktop now (ADR 0058), at the top of the overview under its browser, for whoever may watch
 * it once its computer serves desktops: a request waiting for someone (amber, Abrir), or a line with "Ver a
 * tela" that opens the live panel. `?desktop=1` (a notification's link, the browser card's "Ver a tela
 * inteira", a computer's page) opens it.
 */
export function DesktopNow() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const { agent } = useAgentEdit();
  const toast = useToast();
  const actions = useBrowserHandoffMutations(org.id);
  const status = useDesktopStatus(org.id, agent.id);
  const [asked, clearAsked] = useOpenParam("desktop");
  const [viewing, setViewing] = useState(false);
  useEffect(() => {
    if (asked === null) return;
    setViewing(true);
    clearAsked(null);
  }, [asked, clearAsked]);
  const s = status.data;
  if (!s || !(s.available || viewing)) return null;
  const g = agentGrammar(t, agent.name);
  const handoff = s.handoff;
  const waiting = handoff?.screen === "desktop" && handoff.kind === "ask" && isWaitingHandoff(handoff);
  const mine = handoff?.status === "active" && handoff.screen === "desktop" && handoff.controllerUserId === me.user.id;
  const take = () => {
    if (!handoff) return;
    actions.takeControl.mutate(handoff.id, {
      onSuccess: () => setViewing(true),
      onError: (err) =>
        toast.show(
          (err as { status?: number }).status === 409 ? t("browser.card.busy") : t("browser.card.openFailed"),
          "error",
        ),
    });
  };
  return (
    <section className="brw-now" aria-label={t("desktop.title", g)}>
      {waiting && handoff && (
        <div className="brw-now__row" data-tone="warn">
          <span className="brw-now__ic">
            <Icon name="computer" size={16} />
          </span>
          <span className="brw-now__t">
            <b>{t("desktop.now.needsYou", g)}</b>
            <span>{handoff.instructions}</span>
          </span>
          {s.canControl && (
            <Button size="sm" variant="primary" icon="computer" loading={actions.takeControl.isPending} onClick={take}>
              {t("browser.card.open")}
            </Button>
          )}
        </div>
      )}
      {viewing || mine ? (
        // In control it stays until handed back.
        <DesktopView agentId={agent.id} name={agent.name} onFold={mine ? undefined : () => setViewing(false)} />
      ) : (
        !waiting && (
          <div className="brw-now__row">
            <span className="brw-now__ic">
              <Icon name="computer" size={16} />
            </span>
            <span className="brw-now__t">
              <b>{t("desktop.title", g)}</b>
              <span>{s.running ? t("desktop.now.on") : t("desktop.now.off")}</span>
            </span>
            <Button size="sm" icon="computer" onClick={() => setViewing(true)}>
              {t("desktop.now.see")}
            </Button>
          </div>
        )
      )}
    </section>
  );
}
