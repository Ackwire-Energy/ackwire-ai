import { Button, Icon, type IconName } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { MachineTask } from "@/api/types";
import { formatTime } from "@/lib/format";
import { formatSpan, prOf, type SessionState, sessionState, taskSeconds } from "@/lib/missions";
import { useNow } from "./MissionBits";

/**
 * One row per executor session (ThreadContexto.html, A4): status icon,
 * title, ONE human line (the live last line with the agent's cursor while it
 * runs), time and the PR; opened: "O que mudou · N arquivos" and the output.
 * The sessions don't talk to people: our agent reviews and speaks once.
 */

const ICON: Record<SessionState, IconName> = {
  running: "spinner",
  done: "check",
  failed: "alert",
  interrupted: "pause",
  canceled: "stop",
  queued: "clock",
};

export function SessionRows({
  tasks,
  computer,
  defaultOpen = true,
  foot,
}: {
  tasks: MachineTask[];
  /** "MacBook do Walter", for the summary line. */
  computer?: string | null;
  defaultOpen?: boolean;
  foot?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const running = tasks.filter((x) => x.status === "running").length;
  const now = useNow(running > 0);
  if (tasks.length === 0) return null;
  const count = (status: MachineTask["status"]) => tasks.filter((x) => x.status === status).length;
  const parts = [
    count("done") ? t("missions.sessions.done", { count: count("done") }) : "",
    running ? t("missions.sessions.running", { count: running }) : "",
    count("interrupted") ? t("missions.sessions.interrupted", { count: count("interrupted") }) : "",
    count("failed") ? t("missions.sessions.failed", { count: count("failed") }) : "",
    count("queued") ? t("missions.sessions.queued", { count: count("queued") }) : "",
  ].filter(Boolean);
  return (
    <div className="mi-sessions">
      <button type="button" className="mi-sessions__head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="chevronRight" size={14} />
        <span>
          <b>{t("missions.sessions.count", { count: tasks.length })}</b>
          {parts.length > 0 && ` · ${parts.join(", ")}`}
          {computer && ` · ${computer}`}
        </span>
      </button>
      {open && tasks.map((task) => <SessionRow key={task.id} task={task} now={now} />)}
      {open && foot && (
        <div className="mi-session mi-session--foot">
          <span />
          <span className="mi-session__none">{foot}</span>
          <span />
        </div>
      )}
    </div>
  );
}

function SessionRow({ task, now }: { task: MachineTask; now: number }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [output, setOutput] = useState(false);
  const [all, setAll] = useState(false);
  const state = sessionState(task);
  const pr = prOf(task.lastLine);
  const live = state === "running";
  const files = task.files ?? [];
  const shown = all ? files : files.slice(0, 3);
  const line =
    state === "interrupted"
      ? task.endedAt
        ? t("missions.sessions.stoppedFinal")
        : t("missions.sessions.stoppedAt", {
            time: formatTime(i18n.language, task.lastEventAt ?? task.createdAt),
          })
      : state === "queued"
        ? t("missions.sessions.queuedLine")
        : state === "canceled"
          ? t("missions.sessions.canceledLine")
          : task.lastLine || (live ? t("missions.sessions.working") : "");
  return (
    <>
      <div className="mi-session">
        <span className="mi-session__icon" data-state={state} title={t(`missions.sessions.state.${state}`)}>
          <Icon name={ICON[state]} size={14} />
        </span>
        <button type="button" className="mi-session__title" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <b>
            <span>{task.title}</span>
            <Icon name="chevronRight" size={14} />
          </b>
          {line && (
            <span className="mi-session__line">
              <span key={line}>{line}</span>
              {live && <span className="mi-cursor" aria-hidden="true" />}
            </span>
          )}
          {task.branch && (
            <span className="mi-session__branch">
              <Icon name="pullRequest" size={14} />
              <code>{task.branch}</code>
            </span>
          )}
        </button>
        <span className="mi-session__end">
          <span className="mi-session__time" data-live={live || undefined}>
            {state === "queued" ? "" : formatSpan(t, taskSeconds(task, now))}
          </span>
          {pr &&
            (pr.url ? (
              <a className="mi-pr" href={pr.url} target="_blank" rel="noreferrer">
                <Icon name="pullRequest" size={14} />
                {t("missions.sessions.pr", { number: pr.number })}
              </a>
            ) : (
              <span className="mi-pr">
                <Icon name="pullRequest" size={14} />
                {t("missions.sessions.pr", { number: pr.number })}
              </span>
            ))}
        </span>
      </div>
      {open && (
        <div className="mi-session__more">
          {files.length > 0 ? (
            <>
              <h4>
                {t("missions.sessions.changed")}
                <span>{t("missions.sessions.files", { count: files.length })}</span>
              </h4>
              <ul className="mi-session__files">
                {shown.map((f) => (
                  <li key={f}>
                    <code>{f}</code>
                  </li>
                ))}
              </ul>
              {files.length > 3 && (
                <button type="button" className="mi-link" onClick={() => setAll((v) => !v)}>
                  {all ? t("missions.sessions.less") : t("missions.sessions.more", { count: files.length - 3 })}
                </button>
              )}
            </>
          ) : (
            <>
              <h4>{t("missions.sessions.changed")}</h4>
              <span className="mi-session__none">{t("missions.sessions.nothingYet")}</span>
            </>
          )}
          {output && (
            // Only the last line for now: the full output isn't served yet.
            <pre className="mi-log">
              {task.lastLine || t("missions.sessions.noOutput")}
              {live && <span className="mi-cursor" aria-hidden="true" />}
            </pre>
          )}
          <div>
            <Button size="sm" variant="ghost" icon="code" aria-expanded={output} onClick={() => setOutput((v) => !v)}>
              {output ? t("missions.sessions.hideOutput") : t("missions.sessions.showOutput")}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
