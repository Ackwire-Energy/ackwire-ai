import type { BrowserStep, LiveRun } from "@agenteschat/client";
import { browserSteps, useBrowserHandoffMutations } from "@agenteschat/client";
import { formatTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Button, Chip, Icon, type IconName, PixelSpinner } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/lib/toast";
import { useBrowserLive } from "@/realtime/context";
import { useOrg } from "../org-context";
import "./browser.css";

const STEP_ICON = {
  browser_open: "globe",
  browser_back: "chevronLeft",
  browser_tabs: "layers",
  browser_read: "document",
  browser_click: "arrowRight",
  browser_fill: "edit",
  browser_select: "list",
  browser_check: "check",
  browser_press: "arrowRight",
  browser_scroll: "chevronDown",
  browser_upload: "upload",
  browser_type_secret: "key",
  browser_wait: "clock",
  browser_screenshot: "image",
  browser_ask_person: "person",
  browser_close: "close",
} satisfies Record<string, IconName>;

type StepTool = keyof typeof STEP_ICON;
const isStepTool = (tool: string): tool is StepTool => Object.hasOwn(STEP_ICON, tool);
const iconOf = (tool: string): IconName => (isStepTool(tool) ? STEP_ICON[tool] : "globe");

/** One line of the log, in the person's words ("Abriu loja.exemplo", "Preencheu um campo"). */
function stepText(t: TFunction, s: BrowserStep): string {
  if (s.tool === "browser_open")
    return s.detail
      ? t("browser.watch.step.browser_open", { detail: s.detail })
      : t("browser.watch.step.browser_open_plain");
  return isStepTool(s.tool) ? t(`browser.watch.step.${s.tool}`) : t("browser.watch.step.other");
}

/**
 * The agent at work in its browser, on its message (telas/NavegadorAgente.html
 * "Assistindo"): the page live (only while someone looks), what it did step
 * by step, Assumir (the agent waits, the live view opens) and Parar (closes its browser).
 */
export function BrowserWatchCard({ run, name }: { run: LiveRun; name: string }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const actions = useBrowserHandoffMutations(org.id);
  const steps = browserSteps(run.work);
  const live = useBrowserLive(run.agentId, steps.length > 0);
  const [confirm, setConfirm] = useState(false);
  const [stoppedAt, setStoppedAt] = useState<string | null>(null);
  if (steps.length === 0) return null;
  const g = agentGrammar(t, name);
  const openLive = (watch: boolean) =>
    void navigate({
      to: "/org/$orgId/browser/$agentId",
      params: { orgId: org.id, agentId: run.agentId },
      search: watch ? { watch: 1 } : {},
    });
  const takeover = () =>
    actions.takeover.mutate(run.agentId, {
      onSuccess: () => openLive(false),
      onError: () => toast.show(t("browser.live.actionFailed"), "error"),
    });
  const stop = () =>
    actions.stop.mutate(run.agentId, {
      onSuccess: () => {
        setConfirm(false);
        setStoppedAt(new Date().toISOString());
      },
      onError: () => toast.show(t("browser.live.actionFailed"), "error"),
    });
  if (stoppedAt) {
    return (
      <div className="brw-work">
        <div className="brw-work__head">
          <Icon name="stop" size={14} />
          <b>{t("browser.watch.stopped")}</b>
          <span className="brw-grow" />
          <span className="small muted">
            {t("browser.watch.stoppedBy", { time: formatTime(i18n.language, stoppedAt) })}
          </span>
        </div>
      </div>
    );
  }
  const frame = live.frame;
  const last = steps.length - 1;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
    <div className="brw-work" role="group" aria-label={t("browser.watch.title")}>
      <div className="brw-work__head">
        <Icon name="globe" size={14} />
        <b className="brw-work__label">{t("browser.watch.title")}</b>
        <Chip icon="play">{t("browser.watch.live")}</Chip>
        <span className="brw-grow" />
        {confirm ? (
          <>
            <span className="small muted">{t("browser.watch.stopAsk")}</span>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
              {t("browser.watch.no")}
            </Button>
            <Button size="sm" variant="primary" loading={actions.stop.isPending} onClick={stop}>
              {t("browser.watch.stop")}
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" icon="person" loading={actions.takeover.isPending} onClick={takeover}>
              {t("browser.watch.takeover")}
            </Button>
            <Button size="sm" variant="ghost" icon="stop" onClick={() => setConfirm(true)}>
              {t("browser.watch.stop")}
            </Button>
          </>
        )}
      </div>
      <div className="brw-work__body">
        <div className="brw-mini">
          {frame ? (
            <button type="button" aria-label={t("browser.watch.open")} onClick={() => openLive(true)}>
              <img src={`data:image/jpeg;base64,${frame.data}`} alt={t("browser.live.page", g)} />
            </button>
          ) : (
            <span className="brw-mini__empty">
              <PixelSpinner size={16} />
            </span>
          )}
        </div>
        <ol className="brw-log">
          {steps.map((s, i) => {
            const now = i === last && s.running;
            return (
              <li key={s.id} className={now ? "is-now" : undefined}>
                {now ? <PixelSpinner size={14} /> : <Icon name={iconOf(s.tool)} size={14} />}
                <span>{stepText(t, s)}</span>
                {s.since && <small>{formatTime(i18n.language, new Date(s.since).toISOString())}</small>}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
