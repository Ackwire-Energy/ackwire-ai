import {
  type BrowserTrailStep,
  browserTrailHosts,
  browserTrailHref,
  browserTrailPages,
  browserTrailSpanMs,
} from "@agenteschat/client";
import { formatTime, joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { formatDuration } from "@agenteschat/client/lib/work";
import { Button, Icon, PageSilhouette, SkyStrip } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useDirectory } from "@/hooks/useDirectory";
import { useOrg } from "../org-context";
import { colorOf } from "../Sky";
import { iconOf, stepText, useHeldTakeover } from "./BrowserCard";
import "./browser.css";

/**
 * Where the agent browsed, on its message after the run (telas/NavegadorDepois.html, A with
 * "Página em silhueta"): the closed card stays, still, with a drawn page (never a picture of
 * the real one, ADR 0040 §7), when it ended and how many steps on which sites. Opening it lists
 * the steps by page, each site openable in the person's own browser.
 */
export function BrowserTrailCard({
  agentId,
  runId,
  name,
  steps,
  stopped,
  recent = false,
}: {
  agentId: string;
  /** Its run: while a take over still holds the browser, the live card stands here instead. */
  runId: string | null;
  name: string;
  /** `meta.browser.steps` (`browserTrailOf`). */
  steps: BrowserTrailStep[];
  /** The run was stopped (`meta.canceled`): who pressed Parar, when known. */
  stopped?: { byUserId: string | null } | null;
  /** A recent message: ask the server about a take over (otherwise only what the realtime events said). */
  recent?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const [open, setOpen] = useState(false);
  const held = useHeldTakeover(agentId, runId ?? "", recent && runId !== null);
  const g = agentGrammar(t, name);
  const color = colorOf(dir.agentById.get(agentId));
  const last = steps.at(-1);
  if (!last || held) return null;
  const time = formatTime(i18n.language, last.at);
  const by = stopped?.byUserId ?? null;
  const ended = !stopped
    ? t("browser.after.doneAt", { time })
    : by === me.user.id
      ? t("browser.after.stoppedByYou", { time })
      : by && dir.memberById.get(by)
        ? t("browser.after.stoppedBy", { person: dir.memberById.get(by)?.name, time })
        : t("browser.after.stoppedAt", { time });
  const hosts = browserTrailHosts(steps);
  const count = t("chat.work.steps", { count: steps.length });
  const duration = formatDuration(t, browserTrailSpanMs(steps));
  const summary = hosts.length
    ? t("browser.after.summary", { steps: count, sites: joinNames(hosts, t("newAgent.and")), duration })
    : t("browser.after.summaryNoSite", { steps: count, duration });
  const group = t("browser.inCard.group", g);
  const toggle = open ? t("browser.after.hideSteps") : t("browser.after.showSteps");

  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
    <div className={open ? "brw-ac brw-trail is-open" : "brw-ac brw-trail"} role="group" aria-label={group}>
      <SkyStrip color={color} muted moving={false} />
      <div className="brw-ac__compact">
        <button
          type="button"
          className="brw-ac__thumb brw-trail__shot"
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="brw-trail__bar">
            <i />
            <i />
            <i />
            <span />
          </span>
          <PageSilhouette color={color} />
        </button>
        <button type="button" className="brw-ac__tt" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="brw-ac__tx">
            <b>{group}</b>
            <small>
              <Icon name={stopped ? "stop" : "power"} size={14} />
              <span>{ended}</span>
            </small>
            <span className="brw-ac__hint">{summary}</span>
          </span>
        </button>
        <span className="brw-ac__acts">
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon="chevronDown"
            className="brw-ac__chev"
            aria-label={toggle}
            title={toggle}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          />
        </span>
      </div>
      {open && (
        <ol className="brw-log brw-trail__log">
          {browserTrailPages(steps).map((p, i) => {
            const href = browserTrailHref(p.site);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: pages are a fixed list from the message
              <li key={i} className="brw-trail__page">
                <span className="brw-trail__site">
                  <Icon name="globe" size={14} />
                  <span>
                    {p.host ?? t("browser.after.noSite")}
                    {p.path && <span className="brw-ac__path">{p.path}</span>}
                  </span>
                  {href && (
                    <a
                      className="brw-trail__ext"
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={t("browser.after.openSite", { site: p.site })}
                      title={t("browser.after.openSite", { site: p.site })}
                    >
                      <Icon name="external" size={14} />
                    </a>
                  )}
                </span>
                <ol>
                  {p.steps.map((s, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: steps are a fixed list from the message
                    <li key={j} className={s.failed ? "is-failed" : undefined}>
                      <Icon name={s.failed ? "alert" : iconOf(s.tool)} size={14} />
                      <span>{stepText(t, { id: "", tool: s.tool, detail: s.detail, running: false })}</span>
                      <small>{formatTime(i18n.language, s.at)}</small>
                    </li>
                  ))}
                </ol>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
