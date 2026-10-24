import {
  type BrowserTrailStep,
  browserTrailHosts,
  browserTrailHref,
  browserTrailKind,
  browserTrailLines,
  browserTrailPages,
  browserTrailSpanMs,
} from "@agenteschat/client";
import { formatTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { formatDuration } from "@agenteschat/client/lib/work";
import { BrowserMark, BrowserStrip, Button, Icon, PageSilhouette, SkyStrip } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useDirectory } from "@/hooks/useDirectory";
import { useOrg } from "../org-context";
import { colorOf } from "../Sky";
import { stepText, useHeldTakeover } from "./BrowserCard";
import "./browser.css";

/** A step in the person's words, from the saved trail. */
const said = (t: TFunction, s: BrowserTrailStep) =>
  stepText(t, { id: "", tool: s.tool, detail: s.detail, running: false });
const lower = (s: string) => s.charAt(0).toLocaleLowerCase() + s.slice(1);

/**
 * Where the agent browsed, on its message after the run: the closed card stays, still, with a drawn
 * page (never a picture of the real one, ADR 0040 §7), where it browsed, its steps as pixel columns
 * in the agent's tones (as a routine's runs) and how long. Opening it lists the steps by page,
 * repeats folded into one line, each site openable in the person's own browser.
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
  // Done needs no line (the message has its time); stopped says who and when.
  const ended = !stopped
    ? null
    : by === me.user.id
      ? t("browser.after.stoppedByYou", { time })
      : by && dir.memberById.get(by)
        ? t("browser.after.stoppedBy", { person: dir.memberById.get(by)?.name, time })
        : t("browser.after.stoppedAt", { time });
  const hosts = browserTrailHosts(steps);
  // The site alone, short ("web.whatsapp.com" → "whatsapp.com"): the drawn page already says it browsed.
  const site = hosts[0]?.replace(/^(www|web|m)\./, "");
  const title = !site
    ? t("browser.after.titleNoSite")
    : hosts.length > 1
      ? t("browser.after.titleMore", { site, count: hosts.length - 1 })
      : site;
  const count = t("chat.work.steps", { count: steps.length });
  const duration = formatDuration(t, browserTrailSpanMs(steps));
  const summary = t("browser.after.summaryNoSite", { steps: count, duration });
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
            <b>{title}</b>
            <small className="brw-trail__sum">
              <BrowserStrip kinds={steps.map(browserTrailKind)} color={color} rows={7} />
              <span>{summary}</span>
            </small>
            {ended && (
              <span className="brw-ac__hint">
                <Icon name="stop" size={14} />
                {ended}
              </span>
            )}
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
                  {p.steps[0] && <small>{formatTime(i18n.language, p.steps[0].at)}</small>}
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
                  {browserTrailLines(p.steps).map((line, j) => {
                    const [a, b] = line.steps;
                    if (!a) return null;
                    const text = b
                      ? t("browser.after.pair", { a: said(t, a), b: lower(said(t, b)) })
                      : a.failed
                        ? t("browser.after.failed", { step: said(t, a) })
                        : said(t, a);
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: lines are a fixed list from the message
                      <li key={j} className={a.failed ? "is-failed" : undefined}>
                        <BrowserMark kind={browserTrailKind(a)} color={color} className="brw-trail__mark" />
                        <span>{text}</span>
                        {line.times > 1 && (
                          <b className="brw-trail__times">{t("browser.after.times", { count: line.times })}</b>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
