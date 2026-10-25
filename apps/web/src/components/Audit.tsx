import { type AuditQuery, type AuditRow, useAudit } from "@agenteschat/client";
import { toolActivity } from "@agenteschat/client/lib/activity";
import { dayLabel, formatTime, whenAt } from "@agenteschat/client/lib/format";
import { stepLabel } from "@agenteschat/client/lib/work";
import {
  Button,
  Chip,
  type ChipProps,
  Icon,
  Menu,
  MenuItem,
  Segmented,
  Select,
  Toolbar,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar, AgentAvatar } from "@/components/AgentAvatar";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import "@/components/threads/threads.css";
import "./audit.css";

/**
 * Configurações › Auditoria (telas/Auditoria.html, A · Linha do tempo): the org's audit log as one list
 * by day, a sentence per row (who, what, how it ended), shortcuts on top; a row opens the same panel as
 * a thread in the chat, with what was sent (secrets masked), why it was refused and the approval.
 */

const TOOL_CALL = "tool.call";
type Show = "all" | "problems" | "waiting" | "people";
const SHOWS: Show[] = ["all", "problems", "waiting", "people"];
const ANY = "any";

function queryOf(show: Show, agentId: string): AuditQuery {
  const agent: AuditQuery = agentId === ANY ? {} : { actorType: "agent", actorId: agentId };
  if (show === "problems") return { ...agent, outcome: ["refused", "failed"] };
  if (show === "waiting") return { ...agent, waiting: true };
  if (show === "people") return { actorType: "person", kind: "change" };
  return agent;
}

export function AuditSection() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const [show, setShow] = useState<Show>("all");
  const [agentId, setAgentId] = useState(ANY);
  const [openId, setOpenId] = useState<string | null>(null);
  const audit = useAudit(org.id, queryOf(show, agentId));
  const rows = useMemo(() => audit.data?.pages.flatMap((p) => p.rows) ?? [], [audit.data]);
  const open = rows.find((r) => r.id === openId) ?? null;

  // Esc closes the panel, like a thread's.
  useEffect(() => {
    if (!openId) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpenId(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId]);

  const agentOptions = [
    { value: ANY, label: t("audit.anyAgent") },
    ...dir.agents.map((a) => ({
      value: a.id,
      label: a.name,
      leading: <AgentAvatar agentId={a.id} name={a.name} size="xs" />,
    })),
  ];

  let day = "";
  return (
    <section className="audit" aria-label={t("settings.section.audit")}>
      <Toolbar
        label={t("audit.filters")}
        actions={
          show !== "people" && (
            <Select
              size="sm"
              value={agentId}
              onValueChange={setAgentId}
              options={agentOptions}
              aria-label={t("audit.agent")}
              className="audit__agent"
            />
          )
        }
      >
        <Segmented
          label={t("audit.filters")}
          value={show}
          onValueChange={setShow}
          options={SHOWS.map((s) => ({ value: s, label: t(`audit.filter.${s}`) }))}
        />
      </Toolbar>

      {audit.isPending ? (
        <LoadingList count={6} trailing />
      ) : audit.isError ? (
        <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />
      ) : rows.length === 0 ? (
        <p className="audit__empty">
          {show === "all" && agentId === ANY ? t("audit.empty") : t("audit.emptyFiltered")}
        </p>
      ) : (
        <ul className="audit__list">
          {rows.map((row) => {
            const label = dayLabel(t, i18n.language, row.at);
            const heading = label !== day ? label : null;
            day = label;
            return (
              <li key={row.id}>
                {heading && <h3 className="audit__day">{heading}</h3>}
                <button
                  type="button"
                  className="audit-row"
                  aria-pressed={row.id === openId}
                  onClick={() => setOpenId(row.id)}
                >
                  <Face row={row} />
                  <span className="audit-row__text">
                    <span className="audit-row__title">
                      <Sentence row={row} />
                    </span>
                    <span className="audit-row__sub">{subLine(t, row)}</span>
                  </span>
                  <OutcomeChip row={row} />
                  <time className="audit-row__time" dateTime={row.at}>
                    {formatTime(i18n.language, row.at)}
                  </time>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {audit.hasNextPage && (
        <div className="audit__more">
          <Button loading={audit.isFetchingNextPage} onClick={() => void audit.fetchNextPage()}>
            {t("audit.loadMore")}
          </Button>
        </div>
      )}
      {open && <AuditPanel row={open} onClose={() => setOpenId(null)} />}
    </section>
  );
}

// ── Words ──────────────────────────────────────────────────────────────────

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const lowerFirst = (s: string) => s.charAt(0).toLocaleLowerCase() + s.slice(1);

/** Who did it, by name; null for the system (its sentence stands alone). */
function useActorName(row: AuditRow) {
  const { t } = useTranslation();
  if (row.actor.type === "system") return null;
  return row.actor.name ?? t("audit.removed");
}

/** "Usou o Gmail", "Criou uma tarefa", "Aprovou um pedido", "Criou uma rotina". */
function phrase(t: TFunction, row: AuditRow): string {
  if (row.action === TOOL_CALL) {
    const kind = str(row.details.kind);
    const connector = str(row.details.connector);
    if (connector) return t(kind === "read" ? "audit.call.consulted" : "audit.call.used", { app: connector });
    if (kind === "computer") return t("audit.call.computer");
    // The chat's words for our own tools ("Criou uma tarefa"); its guesses from a name's prefix ("Leu o
    // Drive" for `drive_delete`) only fit reads, so anything else says the tool's name.
    const guessed = toolActivity(row.target.id, null, null);
    const activity =
      (guessed.kind === "consulting" || guessed.kind === "readingDrive") && kind !== "read"
        ? { kind: "usingTool" as const }
        : guessed;
    return stepLabel(t, { ...activity, key: row.id, tool: row.target.id ?? "", ms: null, failed: false, count: 1 });
  }
  const [area = "", rest = ""] = row.action.split(".");
  if (area === "approval") {
    const status = (["approved", "refused", "expired"] as const).find((s) => s === rest);
    if (status) return t(`audit.change.approval.${status}`);
  }
  const last = (rest.split("_").at(-1) ?? "").replace("cancelled", "canceled");
  const verb = VERBS.find((v) => v === last) ?? "other";
  const where = AREAS.find((a) => a === area) ?? "other";
  return t("audit.change.pattern", {
    verb: t(`audit.change.verb.${verb}`),
    area: t(`audit.change.area.${where}`),
  });
}

/** A change's action is `area.what_happened`: its last word is the verb ("page_created" → created). */
const VERBS = [
  "created",
  "deleted",
  "updated",
  "changed",
  "connected",
  "disconnected",
  "reconnected",
  "removed",
  "added",
  "started",
  "stopped",
  "paused",
  "renamed",
  "restored",
  "moved",
  "activated",
  "imported",
  "shared",
  "uploaded",
  "requested",
  "delivered",
  "declined",
  "expired",
  "canceled",
  "sent",
  "push",
  "fetch",
  "exec",
] as const;
const AREAS = [
  "routine",
  "wiki",
  "mission",
  "thread",
  "forum",
  "artifact",
  "agent",
  "machine",
  "sandbox",
  "connector",
  "database",
  "mail_account",
  "mail",
  "secret",
  "skill",
  "storage",
  "organization",
  "account",
  "github_app",
  "git",
  "import",
  "webhook",
  "issue",
  "message",
  "run",
] as const;

function Sentence({ row }: { row: AuditRow }) {
  const { t } = useTranslation();
  const name = useActorName(row);
  const text = phrase(t, row);
  if (!name) return <>{text}</>;
  return (
    <>
      <strong>{name}</strong> {lowerFirst(text)}
    </>
  );
}

/** What the row is about in its own words (the call's title, a change's name). */
const hintOf = (row: AuditRow) =>
  str(row.details.title) ?? str(row.details.name) ?? str(row.details.label) ?? str(row.details.subject);

function whereOf(t: TFunction, row: AuditRow) {
  const c = row.channel;
  if (!c) return null;
  if (c.kind === "dm") return t("audit.where.dm");
  if (c.kind === "forum") return t("audit.where.forum", { name: c.name });
  return `#${c.name}`;
}

function behindOf(t: TFunction, row: AuditRow) {
  const behind = str(row.details.behind);
  if (behind === "person" && row.onBehalfOf) {
    return t("audit.behind.person", { name: row.onBehalfOf.name ?? t("audit.removed") });
  }
  if (behind === "routine") {
    const name = str((row.details.routine as { name?: unknown } | undefined)?.name);
    return name ? t("audit.behind.routine", { name }) : t("audit.behind.routineAny");
  }
  if (behind === "unattended") return t("audit.behind.unattended");
  return null;
}

function subLine(t: TFunction, row: AuditRow) {
  return [hintOf(row), behindOf(t, row), whereOf(t, row)].filter(Boolean).join(" · ");
}

// ── Pieces ─────────────────────────────────────────────────────────────────

function Face({ row, size = "sm" }: { row: AuditRow; size?: "xs" | "sm" }) {
  const { t } = useTranslation();
  const name = useActorName(row) ?? t("audit.system");
  if (row.actor.type === "system" || !row.actor.id) {
    return (
      <span className={`audit-face audit-face--${size}`} aria-hidden="true">
        <Icon name="settings" size={size === "xs" ? 12 : 16} />
      </span>
    );
  }
  return <ActorAvatar actor={{ type: row.actor.type, id: row.actor.id }} name={name} size={size} />;
}

type ChipLook = { icon: ChipProps["icon"]; tone?: ChipProps["tone"]; mood?: "refused" | "failed"; text: string };

/** How it ended: a call's outcome (a waiting call says what became of its approval); an approval's decision. */
function outcomeOf(t: TFunction, row: AuditRow): ChipLook | null {
  if (row.action === TOOL_CALL) {
    if (row.outcome === "pending" && row.approval && row.approval.status !== "pending") {
      const s = row.approval.status;
      if (s === "approved") return { icon: "check", text: t("audit.outcome.approved") };
      if (s === "refused") return { icon: "block", mood: "refused", text: t("audit.outcome.refusedByPerson") };
      if (s === "expired") return { icon: "clock", text: t("audit.outcome.expired") };
      return { icon: "stop", text: t("audit.outcome.canceled") };
    }
    if (row.outcome === "done") return { icon: "check", tone: "done", text: t("audit.outcome.done") };
    if (row.outcome === "failed") return { icon: "alert", mood: "failed", text: t("audit.outcome.failed") };
    if (row.outcome === "refused") return { icon: "block", mood: "refused", text: t("audit.outcome.refused") };
    if (row.outcome === "pending") return { icon: "waiting", tone: "waiting", text: t("audit.outcome.pending") };
    return null;
  }
  if (row.action === "approval.approved") return { icon: "check", text: t("audit.outcome.approved") };
  if (row.action === "approval.refused") return { icon: "block", text: t("audit.outcome.refusedByPerson") };
  if (row.action === "approval.expired") return { icon: "clock", text: t("audit.outcome.expired") };
  return null;
}

function OutcomeChip({ row }: { row: AuditRow }) {
  const { t } = useTranslation();
  const look = outcomeOf(t, row);
  if (!look) return <span />;
  return (
    <Chip icon={look.icon} tone={look.tone} className={look.mood ? `audit-chip--${look.mood}` : undefined}>
      {look.text}
    </Chip>
  );
}

// ── The panel (same as a thread's beside its channel) ───────────────────────

function AuditPanel({ row, onClose }: { row: AuditRow; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const name = useActorName(row) ?? t("audit.system");
  const reason = str(row.details.reason);
  const isCall = row.action === TOOL_CALL;
  const where = whereOf(t, row);
  const connector = str(row.details.connector);
  const look = outcomeOf(t, row);

  const facts: [string, ReactNode][] = [];
  if (isCall) {
    const behind = str(row.details.behind);
    const routine = str((row.details.routine as { name?: unknown } | undefined)?.name);
    if (behind === "person" && row.onBehalfOf) {
      facts.push([
        t("audit.panel.asked"),
        <span key="asked" className="audit-panel__who">
          <ActorAvatar
            actor={{ type: "person", id: row.onBehalfOf.id }}
            name={row.onBehalfOf.name ?? ""}
            size="xs"
          />
          {row.onBehalfOf.name ?? t("audit.removed")}
        </span>,
      ]);
    } else if (behind === "routine") {
      facts.push([t("audit.panel.asked"), routine ? t("audit.panel.routine", { name: routine }) : t("audit.behind.routineAny")]);
    } else if (behind === "unattended") {
      facts.push([t("audit.panel.asked"), <span key="nobody" className="muted">{t("audit.panel.nobody")}</span>]);
    }
  }
  if (where && row.channel) {
    facts.push([
      t("audit.panel.where"),
      <Link key="where" to="/org/$orgId/c/$channelId" params={{ orgId: org.id, channelId: row.channel.id }}>
        {where}
      </Link>,
    ]);
  }
  if (connector) facts.push([t("audit.panel.via"), connector]);
  if (row.approval) facts.push([t("audit.panel.approval"), approvalText(t, row.approval)]);
  facts.push([t("audit.panel.when"), whenAt(t, i18n.language, row.at)]);

  const input = isCall ? (row.details.input as Record<string, unknown> | undefined) : undefined;
  const changeDetails = isCall ? undefined : detailEntries(row.details);
  const reasonKey =
    row.outcome === "refused" || row.outcome === "failed" || row.outcome === "pending" ? row.outcome : "other";

  return (
    <>
      <button type="button" className="thread-panel__scrim" tabIndex={-1} aria-label={t("common.close")} onClick={onClose} />
      <aside className="thread-panel audit-panel" aria-label={t("audit.panel.label")}>
        <header className="channel__header thread-head thread-head--panel">
          <span className="thread-head__who" aria-hidden="true">
            <Face row={row} />
          </span>
          <div className="thread-head__text">
            <h1 className="channel__title thread-title">
              <span className="thread-title__text">{hintOf(row) ?? phrase(t, row)}</span>
            </h1>
            <span className="channel__topic thread-head__meta">
              <span className="thread-head__where">{name}</span>
              <span>·</span>
              <span>{whenAt(t, i18n.language, row.at)}</span>
            </span>
          </div>
          <Menu
            align="end"
            label={t("audit.panel.more")}
            trigger={<Button size="sm" variant="ghost" iconOnly icon="more" aria-label={t("audit.panel.more")} />}
          >
            <MenuItem
              icon="copy"
              onSelect={async () => {
                await navigator.clipboard?.writeText(row.id);
                toast.show(t("audit.panel.copied"));
              }}
            >
              {t("audit.panel.copyLink")}
            </MenuItem>
          </Menu>
          <Button size="sm" variant="ghost" iconOnly icon="close" aria-label={t("common.close")} onClick={onClose} />
        </header>

        <div className="thread-panel__page audit-panel__body">
          <p className="audit-panel__lead">
            <Sentence row={row} />
          </p>
          {look && (
            <div>
              <OutcomeChip row={row} />
            </div>
          )}
          {reason && (
            <div className={`audit-panel__reason audit-panel__reason--${reasonKey}`}>
              <Icon name={reasonKey === "refused" ? "block" : reasonKey === "failed" ? "alert" : "info"} size={16} />
              <span>
                <strong>{t(`audit.panel.reason.${reasonKey}`)}:</strong> {reason}
              </span>
            </div>
          )}
          <dl className="audit-panel__facts">
            {facts.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          {input && Object.keys(input).length > 0 && (
            <div className="audit-panel__sent">
              <h4>{t("audit.panel.sent")}</h4>
              <KeyValues entries={Object.entries(input)} />
              <p className="audit-panel__hint">{t("audit.panel.sentHint")}</p>
            </div>
          )}
          {changeDetails && changeDetails.length > 0 && (
            <div className="audit-panel__sent">
              <h4>{t("audit.panel.details")}</h4>
              <KeyValues entries={changeDetails} />
            </div>
          )}
          <details className="audit-panel__tech">
            <summary>
              <Icon name="chevronRight" size={14} />
              {t("audit.panel.tech")}
            </summary>
            <dl>
              <dt>{t("audit.panel.techAction")}</dt>
              <dd>{row.action}</dd>
              {isCall && row.target.id && (
                <>
                  <dt>{t("audit.panel.techTool")}</dt>
                  <dd>{row.target.id}</dd>
                </>
              )}
              {str(row.details.kind) && (
                <>
                  <dt>{t("audit.panel.techKind")}</dt>
                  <dd>{str(row.details.kind)}</dd>
                </>
              )}
              {row.runId && (
                <>
                  <dt>{t("audit.panel.techRun")}</dt>
                  <dd>{row.runId}</dd>
                </>
              )}
              <dt>{t("audit.panel.techId")}</dt>
              <dd>{row.id}</dd>
            </dl>
          </details>
        </div>

        {(row.channel || row.approval?.status === "pending") && (
          <footer className="audit-panel__foot">
            {row.approval?.status === "pending" && (
              <Button asChild variant="primary" icon="waiting">
                <Link to="/org/$orgId/approvals" params={{ orgId: org.id }} search={{ open: row.approval.id }}>
                  {t("audit.panel.openApproval")}
                </Link>
              </Button>
            )}
            {row.channel && (
              <Button asChild icon="message">
                <Link to="/org/$orgId/c/$channelId" params={{ orgId: org.id, channelId: row.channel.id }}>
                  {t("audit.panel.openConversation")}
                </Link>
              </Button>
            )}
          </footer>
        )}
      </aside>
    </>
  );
}

function approvalText(t: TFunction, a: NonNullable<AuditRow["approval"]>) {
  const who = a.decidedBy?.name ?? t("audit.panel.someone");
  if (a.status === "pending") return t("audit.panel.approvalWaiting");
  if (a.status === "approved") return t("audit.panel.approvalApproved", { name: who });
  if (a.status === "refused") return t("audit.panel.approvalRefused", { name: who });
  if (a.status === "expired") return t("audit.panel.approvalExpired");
  return t("audit.panel.approvalCanceled");
}

/** A change's details worth showing (ids and the call's own fields stay in the technical part). */
const HIDDEN_DETAILS = new Set(["approvalId", "agentId", "kind", "behind", "input", "reason", "routine"]);
function detailEntries(details: Record<string, unknown>): [string, unknown][] {
  return Object.entries(details).filter(([k, v]) => !HIDDEN_DETAILS.has(k) && v !== null && v !== "");
}

function KeyValues({ entries }: { entries: [string, unknown][] }) {
  const { t } = useTranslation();
  return (
    <dl className="audit-kv">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>
            {v === "***" ? (
              <span className="audit-kv__hidden">
                <Icon name="lock" size={14} />
                {t("audit.panel.hidden")}
              </span>
            ) : typeof v === "string" ? (
              v
            ) : (
              JSON.stringify(v)
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
