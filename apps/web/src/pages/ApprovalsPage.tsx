import type { Agent, Approval, ConnectorDef, Member } from "@agenteschat/client";
import {
  sendHelpers,
  useApproval,
  useApprovals,
  useCatalog,
  useChannels,
  useCustomServers,
  useDecideApproval,
  useDecideApprovals,
  usePostMessage,
  useRoles,
} from "@agenteschat/client";
import { approvalCards, approveAllScope } from "@agenteschat/client/lib/approval-card";
import { aheadPhase, approveAlwaysOffered } from "@agenteschat/client/lib/approval-kind";
import { approvalOriginShort, approvalOriginWords, approvalWhy } from "@agenteschat/client/lib/approval-origin";
import {
  aheadEndLine,
  approvalDecidingKeys,
  approvalGroupWaitsFor,
  approvalWaitsFor,
  requesterDecidesLine,
} from "@agenteschat/client/lib/approval-words";
import { fromServer, itemName } from "@agenteschat/client/lib/connected";
import { daysBetween, joinNames, nextLabel, relativeTime, timeLeft } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { everyoneOf, grants } from "@agenteschat/client/lib/roles";
import { connectorName } from "@agenteschat/client/lib/scopes";
import {
  Button,
  Chip,
  CriteriaPixels,
  cx,
  DetailsDialog,
  DetailsSection,
  EmptyState,
  ExpiryFuse,
  Icon,
  type IconName,
  Kbd,
  SearchInput,
  Segmented,
  Toolbar,
  WorkSweep,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { AgentAvatar, AgentWho } from "@/components/AgentAvatar";
import {
  AheadLine,
  ApproveAlways,
  approvalAction,
  approvalReadsOnly,
  approvalRisk,
  approvalTitle,
  approvalTraits,
  approvalValues,
  CancelAhead,
  decisionLabel,
} from "@/components/ApprovalItem";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { EmailLetter } from "@/components/EmailLetter";
import { HelpLink } from "@/components/HelpLink";
import { ErrorState, LoadingCards } from "@/components/Loading";
import {
  MissionCommandsPending,
  MissionsWaitingList,
  missionsWaiting,
  pendingCommandCount,
  useMissionsWaitingYou,
} from "@/components/missions/MissionWaiting";
import { useOrg } from "@/components/org-context";
import { colorOf, prepareBurst } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";
import { TYPED_VALUES } from "@/i18n";
import { useOpenParam } from "@/lib/open-param";
import { useToast } from "@/lib/toast";
import "./approvals.css";

type Filter = "pending" | "approved" | "refused" | "expired" | "all";
const FILTERS: Filter[] = ["pending", "approved", "refused", "expired", "all"];
const TTL_MS = 24 * 3_600_000;
const URGENT_MS = 3_600_000;
/** Approved without a result for this long: it ran before results were kept (or the run died); stop showing "running". */
const RUNNING_FOR_MS = 15 * 60_000;

/** Where an approval goes on this screen. */
export type ApprovalPhase =
  | "waiting"
  | "running"
  | "scheduled"
  | "done"
  | "failed"
  | "refused"
  | "expired"
  | "canceled";

export function approvalPhase(a: Approval, now = Date.now()): ApprovalPhase {
  if (a.status === "pending") return "waiting";
  if (a.status === "approved") {
    if (a.result) return a.result.ok ? "done" : "failed";
    if (a.executedAt) return "done";
    // Approved ahead: it waits for its time, when its routine's run does it.
    if (aheadPhase(a) === "scheduled") return "scheduled";
    const decided = a.decidedAt ? new Date(a.decidedAt).getTime() : 0;
    return now - decided < RUNNING_FOR_MS ? "running" : "done";
  }
  return a.status;
}

const bucketOf = (p: ApprovalPhase): Exclude<Filter, "all"> =>
  p === "waiting" || p === "running"
    ? "pending"
    : p === "done" || p === "failed" || p === "scheduled"
      ? "approved"
      : p === "refused"
        ? "refused"
        : "expired";

/** Waiting first, the one closest to expiring on top; running after them. */
export function sortOpen(list: Approval[]) {
  return [...list].sort((a, b) => {
    const ra = approvalPhase(a) === "running" ? 1 : 0;
    const rb = approvalPhase(b) === "running" ? 1 : 0;
    return ra - rb || a.expiresAt.localeCompare(b.expiresAt);
  });
}

const decidedAt = (a: Approval) => a.decidedAt ?? (a.status === "expired" ? a.expiresAt : a.createdAt);

/** The top-level scalar values of the action (what the card shows; the details show them all). */
function scalars(params: Record<string, unknown>) {
  return Object.entries(params ?? {}).filter(
    (e): e is [string, string | number | boolean] =>
      typeof e[1] === "string" || typeof e[1] === "number" || typeof e[1] === "boolean",
  );
}

/** A GitHub PR the action points at, when its values say so. */
function prLink(a: Approval) {
  if (a.connector !== "github") return null;
  const p = a.params ?? {};
  const pr = p.pullNumber ?? p.pull_number ?? p.pr ?? p.number;
  const owner = typeof p.owner === "string" ? p.owner : null;
  const repo = typeof p.repo === "string" ? p.repo : null;
  if (!repo || (typeof pr !== "number" && typeof pr !== "string")) return null;
  const full = owner && !repo.includes("/") ? `${owner}/${repo}` : repo;
  return /^[\w.-]+\/[\w.-]+$/.test(full) && /^\d+$/.test(String(pr)) ? `https://github.com/${full}/pull/${pr}` : null;
}

const TRAIT_ICON: Record<ReturnType<typeof approvalTraits>[number], IconName> = {
  production: "cloud",
  irreversible: "alert",
  reversible: "undo",
  external: "send",
  unsent: "archiveBox",
  deletable: "undo",
};

/**
 * Aprovações: who waits on you, each request with its
 * exact action, then the history. Under the requests, the missions' command
 * cards and the decisions and reviews waiting on you in missions (ADR 0029).
 * A request's details open in the centered details dialog (`?open=<id>`).
 */
export function ApprovalsPage() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const approvals = useApprovals(org.id);
  const dir = useDirectory(org.id);
  const channels = useChannels(org.id);
  const [filter, setFilter] = useState<Filter>("pending");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useOpenParam();
  const [refusing, setRefusing] = useState<string | null>(null);
  const all = approvals.data ?? [];
  const channelName = (id: string) => channels.data?.find((c) => c.id === id)?.name ?? "";
  const query = q.trim().toLowerCase();
  const matches = (a: Approval) =>
    !query ||
    [
      approvalTitle(t, a),
      dir.agentById.get(a.agentId)?.name ?? "",
      channelName(a.channelId),
      ...scalars(a.params).map(([, v]) => String(v)),
    ]
      .join(" ")
      .toLowerCase()
      .includes(query);
  const open = sortOpen(all.filter((a) => bucketOf(approvalPhase(a)) === "pending"));
  const decided = all
    .filter((a) => bucketOf(approvalPhase(a)) !== "pending")
    .sort((a, b) => decidedAt(b).localeCompare(decidedAt(a)));
  const waiting = open.filter((a) => a.status === "pending");
  const mine = waiting.filter((a) => a.canDecide);
  const urgent = mine[0];
  const urgentLeft = urgent && new Date(urgent.expiresAt).getTime() - Date.now();
  const opened = all.find((a) => a.id === openId) ?? null;
  const shownOpen = filter === "pending" || filter === "all" ? open.filter(matches) : [];
  const shownDecided = decided.filter(
    (a) => matches(a) && (filter === "all" || filter === "pending" || bucketOf(approvalPhase(a)) === filter),
  );
  // What J/K walk through while the details are open: the requests in the order shown.
  const order = [...shownOpen, ...(filter === "pending" ? shownDecided.slice(0, 3) : shownDecided)].map((a) => a.id);
  const closeDetails = () => {
    setOpenId(null);
    setRefusing(null);
  };
  // Missions you own or decide in: the executor's commands and what waits on you (decisions, reviews).
  const { missions } = useMissionsWaitingYou();
  const commands = pendingCommandCount(missions);
  const missionWaiting = missionsWaiting(missions).length > 0;
  const waitingYou = mine.length + commands;

  // J/K walk the requests, A approves (high risk: focuses the hold), R refuses, / searches, Escape closes.
  // In the details dialog: J/K move to the next request, A and R act on the open one (Esc is the dialog's).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest("input, textarea, [contenteditable], [role=menu], [role=listbox]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      const dialog = el?.closest("[role=dialog]");
      if (dialog) {
        if (!dialog.classList.contains("ap-dialog") || !openId) return;
        if (key === "j" || key === "k") {
          e.preventDefault();
          const i = order.indexOf(openId);
          const next = order[Math.max(0, Math.min(order.length - 1, i + (key === "j" ? 1 : -1)))];
          if (next && next !== openId) {
            setRefusing(null);
            setOpenId(next);
          }
        } else if (key === "a" || key === "r") {
          const a = all.find((x) => x.id === openId);
          if (a?.status !== "pending" || !a.canDecide) return;
          e.preventDefault();
          if (key === "r") setRefusing(a.id);
          else dialog.querySelector<HTMLElement>(`[data-approve="${a.id}"]`)?.focus();
        }
        return;
      }
      const cards = [...document.querySelectorAll<HTMLElement>(".ap-card")];
      const current = el?.closest<HTMLElement>(".ap-card") ?? null;
      const id = current?.dataset.id ?? openId;
      if (e.key === "Escape") {
        if (refusing) setRefusing(null);
        else setOpenId(null);
      } else if (e.key === "/") {
        e.preventDefault();
        document.querySelector<HTMLInputElement>(".ap-tools__search input")?.focus();
      } else if (key === "j" || key === "k") {
        e.preventDefault();
        const i = current ? cards.indexOf(current) : -1;
        const next = cards[Math.max(0, Math.min(cards.length - 1, i + (key === "j" ? 1 : -1)))];
        next?.focus();
      } else if (e.key === "Enter" && current?.dataset.id && el === current) {
        e.preventDefault();
        setOpenId(current.dataset.id);
      } else if ((key === "a" || key === "r") && id) {
        const a = all.find((x) => x.id === id);
        if (a?.status !== "pending" || !a.canDecide) return;
        e.preventDefault();
        if (key === "r") setRefusing(a.id);
        else document.querySelector<HTMLElement>(`[data-approve="${a.id}"]`)?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [all, openId, refusing, order, setOpenId]);

  const countOf = (f: Filter) =>
    f === "all"
      ? all.length
      : all.filter((a) => bucketOf(approvalPhase(a)) === f).length + (f === "pending" ? commands : 0);
  const waiters = [...new Set(mine.map((a) => a.agentId))];

  return (
    <div className="page page--list ap">
      <div className="ap__main">
        <header className="list-head">
          <div>
            <h1>{t("approvals.title")}</h1>
            <p className="list-head__sub">
              {waitingYou > 0 ? (
                <>
                  {t("approvals.summary", { count: waitingYou })}
                  {urgentLeft && urgentLeft <= 2 * URGENT_MS
                    ? ` · ${t("approvals.urgent", { time: timeLeft(t, urgent.expiresAt) ?? "" })}`
                    : ""}
                </>
              ) : (
                t("approvals.nothing")
              )}
            </p>
          </div>
        </header>
        <Toolbar
          label={t("approvals.filters")}
          search={
            <SearchInput
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("approvals.search")}
              aria-label={t("approvals.search")}
              className="ap-tools__search"
            />
          }
        >
          <Segmented
            label={t("approvals.filters")}
            value={filter}
            onValueChange={setFilter}
            options={FILTERS.map((f) => ({ value: f, label: t(`approvals.filter.${f}`), count: countOf(f) }))}
          />
        </Toolbar>

        {filter === "pending" && waiters.length > 1 && (
          <div className="ap-waiters">
            <span className="ap-waiters__faces">
              {waiters.map((id) => (
                <AgentAvatar key={id} agentId={id} name={dir.agentById.get(id)?.name ?? ""} size="sm" state="waiting" />
              ))}
            </span>
            <span className="ap-waiters__text">
              <Trans
                i18nKey="approvals.waiters"
                count={waiters.length}
                values={{
                  names: joinNames(
                    waiters.map((id) => dir.agentById.get(id)?.name ?? ""),
                    t,
                  ),
                }}
                components={{ b: <b /> }}
                {...TYPED_VALUES}
              />
            </span>
          </div>
        )}

        {approvals.isLoading && <LoadingCards count={2} />}
        {approvals.isError && !approvals.data && (
          <ErrorState error={approvals.error} onRetry={() => void approvals.refetch()} />
        )}
        {approvals.isSuccess &&
          filter === "pending" &&
          shownOpen.length === 0 &&
          !query &&
          commands === 0 &&
          !missionWaiting && (
            <EmptyState sky title={t("approvals.emptyTitle")}>
              <HelpLink slug="approvals">{t("approvals.how")}</HelpLink>
            </EmptyState>
          )}
        {approvals.isSuccess && query && shownOpen.length === 0 && shownDecided.length === 0 && (
          <EmptyState icon="search">{t("approvals.noResults")}</EmptyState>
        )}

        {shownOpen.length > 0 && (
          <section className="ap-cards" aria-label={t("approvals.filter.pending")}>
            {approvalCards(shownOpen).map((items) => {
              const cards = items.map((a) => (
                <RequestCard
                  key={a.id}
                  approval={a}
                  agent={dir.agentById.get(a.agentId)}
                  members={dir.memberById}
                  channel={channelName(a.channelId)}
                  selected={openId === a.id}
                  refusing={refusing === a.id && openId !== a.id}
                  onOpen={() => setOpenId(a.id)}
                  onRefuse={() => setRefusing(a.id)}
                  onCancelRefuse={() => setRefusing(null)}
                />
              ));
              const first = items[0];
              if (!first || items.length < 2) return cards;
              // Requests sharing one card in the conversation: together, with "Aprovar tudo".
              const agent = dir.agentById.get(first.agentId);
              const partial = approveAllPartial(
                t,
                items,
                approvalGroupWaitsFor(items, dir.memberById.get(first.ownerUserId ?? agent?.ownerUserId ?? "")?.name),
              );
              return (
                <section key={first.messageId ?? first.id} className="ap-group" aria-label={agent?.name}>
                  <div className="ap-group__head">
                    <span>
                      <Trans
                        i18nKey="approvals.groupHead"
                        count={items.length}
                        values={{ name: agent?.name ?? t("channel.unknownAgent") }}
                        components={{
                          b: <AgentWho agentId={first.agentId} name={agent?.name ?? t("channel.unknownAgent")} />,
                        }}
                        {...TYPED_VALUES}
                      />
                    </span>
                    <span className="ap-grow" />
                    <ApproveAll items={items} />
                  </div>
                  {partial && <p className="ap-group__note">{partial}</p>}
                  {cards}
                </section>
              );
            })}
          </section>
        )}

        {filter === "pending" && (
          <>
            <MissionCommandsPending missions={missions} query={query} />
            <MissionsWaitingList missions={missions} query={query} />
          </>
        )}

        {filter === "pending"
          ? shownDecided.length > 0 && (
              <section className="ap-history">
                <div className="list-group-head">
                  <h2>{t("approvals.recent")}</h2>
                  <span className="ap-grow" />
                  <Button variant="ghost" size="sm" onClick={() => setFilter("all")}>
                    {t("approvals.seeHistory")}
                  </Button>
                </div>
                <div className="list-card">
                  {shownDecided.slice(0, 3).map((a) => (
                    <HistoryRow key={a.id} approval={a} selected={openId === a.id} onOpen={() => setOpenId(a.id)} />
                  ))}
                </div>
              </section>
            )
          : groups(shownDecided).map(([key, list]) => (
              <section key={key} className="ap-history">
                <div className="list-group-head">
                  <h2>{t(`approvals.groups.${key}`)}</h2>
                  <span className="list-group-head__count">{list.length}</span>
                </div>
                <div className="list-card">
                  {list.map((a) => (
                    <HistoryRow key={a.id} approval={a} selected={openId === a.id} onOpen={() => setOpenId(a.id)} />
                  ))}
                </div>
              </section>
            ))}
        {approvals.isSuccess && filter !== "pending" && !query && shownOpen.length + shownDecided.length === 0 && (
          <EmptyState icon="approve">{t("approvals.noResults")}</EmptyState>
        )}
      </div>
      {opened && (
        <ApprovalDetails
          key={opened.id}
          approval={opened}
          all={all}
          channel={channelName(opened.channelId)}
          refusing={refusing === opened.id}
          onRefuse={() => setRefusing(opened.id)}
          onCancelRefuse={() => setRefusing(null)}
          onClose={closeDetails}
        />
      )}
    </div>
  );
}

function groups(list: Approval[]): ["today" | "yesterday" | "earlier", Approval[]][] {
  const out: ["today" | "yesterday" | "earlier", Approval[]][] = [
    ["today", []],
    ["yesterday", []],
    ["earlier", []],
  ];
  for (const a of list) {
    const d = daysBetween(decidedAt(a), new Date());
    out[d <= 0 ? 0 : d === 1 ? 1 : 2]?.[1].push(a);
  }
  return out.filter(([, l]) => l.length > 0);
}

/** "github · acme" with the brand icon, or the app's own tool. */
type ApprovalVia = {
  kind: "mail" | "connector" | "own";
  name: string;
  account: string | null;
  def: ConnectorDef | null;
  /** A server connected by address: its own icon. */
  image?: string | null;
};

/** What an approval goes through: a mailbox, a server connected by address, a catalog connector, or the app itself. */
function useApprovalVia(approval: Approval): ApprovalVia {
  const { t } = useTranslation();
  const { org } = useOrg();
  const catalog = useCatalog();
  // A server connected by address (`custom:{connectionId}`): its own name, and the preset's icon when it came from one.
  const customId = approval.connector?.startsWith("custom:") ? approval.connector.slice("custom:".length) : null;
  const servers = useCustomServers(org.id, customId !== null);
  // An email goes through a mailbox, not a catalog connector ("email" has no entry): the box and its provider.
  if (approval.email)
    return { kind: "mail", name: approval.email.mailbox, account: approval.email.provider, def: null };
  if (!approval.connector) return { kind: "own", name: t("approvals.panel.builtIn"), account: null, def: null };
  const server = customId ? servers.data?.find((s) => s.id === customId) : undefined;
  const custom = server ? fromServer(server, catalog.data?.connectors ?? []) : null;
  const def = custom ? custom.def : (catalog.data?.connectors.find((c) => c.id === approval.connector) ?? null);
  const name = custom
    ? itemName(t, custom)
    : customId
      ? t("approvals.panel.orgConnector")
      : connectorName(t, def ?? { id: approval.connector, label: approval.connector });
  return { kind: "connector", name, account: approval.connectorAccount ?? null, def, image: custom?.image };
}

function ViaGlyph({ via }: { via: ApprovalVia }) {
  if (via.kind === "connector") return <ConnectorIcon def={via.def} image={via.image} label={via.name} />;
  return (
    <span className="ap-conn__own" aria-hidden="true">
      <Icon name={via.kind === "mail" ? "mail" : "shield"} size={14} />
    </span>
  );
}

export function ConnectorLine({ approval }: { approval: Approval }) {
  const via = useApprovalVia(approval);
  return (
    <span className="ap-conn">
      <ViaGlyph via={via} />
      <b>{via.name}</b>
      {via.account && <span className="ap-conn__account">· {via.account}</span>}
    </span>
  );
}

/** Only the logo, its name in a tooltip and for screen readers (the approval sentence in Notificações). */
export function ConnectorMark({ approval }: { approval: Approval }) {
  const via = useApprovalVia(approval);
  const label = via.account ? `${via.name} · ${via.account}` : via.name;
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so a keyboard reaches the name in its tooltip
    <span className="ap-conn-mark" role="img" aria-label={label} data-tip={label} tabIndex={0}>
      <ViaGlyph via={via} />
    </span>
  );
}

/**
 * The exact action, in words (AprovacaoConector B): the connector and "Só lê" on one line, then its values
 * with labels; a list shows a few as chips, the details every one, and the tool's own name and values
 * behind "Detalhes técnicos". An email shows as the email itself.
 */
export function ExactAction({ approval, max }: { approval: Approval; max?: number }) {
  const { t } = useTranslation();
  // An email shows as the email itself (folded in lists, whole in the details).
  if (approval.email) return <EmailLetter email={approval.email} full={!max} />;
  const full = max === undefined;
  const values = approvalValues(approval, full ? { long: true } : { max });
  return (
    <div className="ap-exact">
      <div className="ap-exact__via">
        <ConnectorLine approval={approval} />
        {approvalReadsOnly(approval) && <Chip icon="eye">{t("approvals.readsOnly")}</Chip>}
      </div>
      {values.length > 0 &&
        (full ? (
          <dl className="ap-exact__rows">
            {values.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <div className="ap-exact__facts">
            {values.map(([label, value]) => (
              <Chip key={label}>
                {label}: {value}
              </Chip>
            ))}
          </div>
        ))}
      {full && (
        <details className="ap-exact__tech">
          <summary>{t("approvals.technical")}</summary>
          <pre>{`${approval.tool}\n${JSON.stringify(approval.params ?? {}, null, 2)}`}</pre>
        </details>
      )}
    </div>
  );
}

/** "Pedido pela rotina «X» enquanto ninguém acompanhava": asked while nobody was watching (ADR 0053 §8). */
function ApprovalOrigin({ approval }: { approval: Approval }) {
  const { t } = useTranslation();
  const origin = approvalOriginWords(approval);
  if (!origin) return null;
  const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  return (
    <p className="ap-origin ac-iconline">
      <Icon name="routines" size={14} />
      <span>{tt(origin.key, origin.values)}</span>
    </p>
  );
}

function Traits({ approval }: { approval: Approval }) {
  const { t } = useTranslation();
  const traits = approvalTraits(approval);
  if (traits.length === 0 && !approval.issue) return null;
  return (
    <div className="ap-traits">
      {traits.map((k) => (
        <Chip key={k} icon={TRAIT_ICON[k]}>
          {t(`approvals.trait.${k}`)}
        </Chip>
      ))}
      {approval.issue && (
        <Chip icon="issues">
          #{approval.issue.number} {approval.issue.title}
        </Chip>
      )}
    </div>
  );
}

/** The time a decision has left ("23 h para decidir", "expira em 12 min"): an approval's, or any request's. */
export function expiryText(t: TFunction, a: Pick<Approval, "expiresAt">) {
  const left = timeLeft(t, a.expiresAt);
  if (!left) return t("approval.expired");
  return new Date(a.expiresAt).getTime() - Date.now() <= URGENT_MS
    ? t("approvals.leftUrgent", { time: left })
    : t("approvals.left", { time: left });
}

/** Approve: one click, or a hold for high risk (let go early and nothing happens). */
export function ApproveButton({ approval, block }: { approval: Approval; block?: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const decide = useDecideApproval(org.id);
  return (
    <HoldToApprove
      label={t(`approval.approve.${approvalAction(approval)}`)}
      high={approvalRisk(approval) === "high"}
      block={block}
      id={approval.id}
      pending={decide.isPending}
      onGo={(el) => {
        // Approved: a burst of the agent's pixels from its avatar.
        const burst = prepareBurst(el);
        decide.mutate({ id: approval.id, decision: "approve" }, { onSuccess: burst });
      }}
    />
  );
}

/** The approve button itself: one click, or held for `high` risk; `id` lets A focus it. */
export function HoldToApprove({
  label,
  high,
  block,
  id,
  pending,
  onGo,
}: {
  label: string;
  high: boolean;
  block?: boolean;
  id: string;
  pending: boolean;
  onGo: (el: HTMLElement) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  if (!high)
    return (
      <Button
        variant="primary"
        size="sm"
        block={block}
        icon="check"
        data-approve={id}
        disabled={pending}
        loading={pending}
        onClick={(e) => onGo(e.currentTarget)}
      >
        {label}
      </Button>
    );
  const start = (el: HTMLElement) => {
    if (timer.current || pending) return;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(false);
      onGo(el);
    }, 1100);
  };
  const stop = () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };
  return (
    <Button
      variant="primary"
      size="sm"
      block={block}
      icon="check"
      className={cx("ap-hold", holding && "is-holding")}
      data-approve={id}
      aria-label={t("approvals.holdLabel", { action: label })}
      disabled={pending}
      loading={pending}
      onPointerDown={(e: PointerEvent<HTMLButtonElement>) => {
        if (e.button > 0) return;
        start(e.currentTarget);
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat) {
          e.preventDefault();
          start(e.currentTarget);
        }
      }}
      onKeyUp={(e: KeyboardEvent<HTMLButtonElement>) => {
        if (e.key === " " || e.key === "Enter") stop();
      }}
      onClick={(e) => {
        // A plain click (no hold) only explains.
        if (e.detail > 0 && !timer.current && !pending) toast.show(t("approvals.holdHint"), "info");
      }}
    >
      {holding ? t("approvals.holding") : t("approvals.hold")}
    </Button>
  );
}

/**
 * "Aprovar tudo" / "Agora não para todos" over one card's requests: exactly the ones listed now that this person
 * may decide (one joining during the click is never approved unseen). Held when any of them is high risk.
 * Nothing when fewer than two are theirs: each item's own buttons do.
 */
export function ApproveAll({ items }: { items: Approval[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const decide = useDecideApprovals(org.id);
  const { ids } = approveAllScope(items);
  if (ids.length < 2) return null;
  const high = items.some((a) => ids.includes(a.id) && approvalRisk(a) === "high");
  return (
    <>
      <HoldToApprove
        label={t("approval.all.approve")}
        high={high}
        id={`all-${ids[0]}`}
        pending={decide.isPending}
        onGo={(el) => {
          const burst = prepareBurst(el);
          decide.mutate({ ids, decision: "approve" }, { onSuccess: burst });
        }}
      />
      <Button
        size="sm"
        disabled={decide.isPending}
        loading={decide.isPending && decide.variables?.decision === "refuse"}
        onClick={() => decide.mutate({ ids, decision: "refuse" })}
      >
        {t("approval.all.refuse")}
      </Button>
    </>
  );
}

/** Said when this person may decide only some of a card's requests: "Aprovar tudo" covers only those. */
export function approveAllPartial(t: TFunction, items: Approval[], who: string | undefined) {
  const { ids, waiting, blocked } = approveAllScope(items);
  if (blocked === 0 || ids.length === 0) return null;
  return t("approval.all.partial", {
    mine: ids.length,
    count: waiting,
    who: who ?? t("approval.all.partialAdmin"),
  });
}

const SUGGESTIONS = ["later", "review", "tests", "smaller"] as const;

/** Refuse with a reason the agent reads (and keeps as a lesson). */
export function RefuseBox({ approval, agent, onCancel }: { approval: Approval; agent?: Agent; onCancel: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const decide = useDecideApproval(org.id);
  const [reason, setReason] = useState("");
  const g = agentGrammar(agent?.name ?? "");
  const id = `ap-reason-${approval.id}`;
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const send = () =>
    decide.mutate(
      { id: approval.id, decision: "refuse", reason: reason.trim() || undefined },
      { onSuccess: () => toast.show(t("approvals.refused", { name: g.name }), "info") },
    );
  return (
    <div className="ap-refuse">
      <label htmlFor={id}>{t("approvals.refuseLabel")}</label>
      <textarea
        id={id}
        ref={ref}
        rows={2}
        value={reason}
        placeholder={t("approvals.refusePlaceholder")}
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
          if (e.key === "Escape") onCancel();
        }}
      />
      <div className="ap-refuse__suggest">
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" onClick={() => setReason(t(`approvals.suggest.${s}`))}>
            {t(`approvals.suggest.${s}`)}
          </button>
        ))}
      </div>
      <div className="ap-refuse__row">
        <span className="ap-refuse__learn">{t("approvals.refuseLearn", { context: g.context, name: g.name })}</span>
        <span className="ap-grow" />
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("approvals.back")}
        </Button>
        <Button
          variant="danger"
          size="sm"
          kbd={["⌘", "↵"]}
          loading={decide.isPending}
          disabled={decide.isPending}
          onClick={send}
        >
          {t("approvals.refuseConfirm")}
        </Button>
      </div>
    </div>
  );
}

/** A request waiting on a person (or running right after approval). */
function RequestCard({
  approval: a,
  agent,
  members,
  channel,
  selected,
  refusing,
  onOpen,
  onRefuse,
  onCancelRefuse,
}: {
  approval: Approval;
  agent: Agent | undefined;
  members: Map<string, Member>;
  channel: string;
  selected: boolean;
  refusing: boolean;
  onOpen: () => void;
  onRefuse: () => void;
  onCancelRefuse: () => void;
}) {
  const { t, i18n } = useTranslation();
  const name = agent?.name ?? t("channel.unknownAgent");
  const g = agentGrammar(name);
  const phase = approvalPhase(a);
  const running = phase === "running";
  const leftMs = new Date(a.expiresAt).getTime() - Date.now();
  const waits = approvalWaitsFor(a, members.get(a.ownerUserId ?? agent?.ownerUserId ?? "")?.name);
  const title = approvalTitle(t, a);
  const origin = approvalOriginShort(a);
  const why = approvalWhy(a);
  const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  return (
    <article
      className={cx("ap-card", selected && "is-selected", running && "is-running")}
      data-id={a.id}
      data-burst=""
      tabIndex={-1}
      aria-label={title}
    >
      <span className="ap-card__face">
        <AgentAvatar
          agentId={a.agentId}
          name={name}
          size="md"
          state={running ? "writing" : "waiting"}
          running={running}
        />
      </span>
      <div className="ap-card__meta">
        <b>{name}</b>
        <span>{t(`approvals.verb.${approvalAction(a)}`)}</span>
        {origin && (
          <span className="ap-card__origin">
            · <Icon name="routines" size={14} />
            {tt(origin.key, origin.values)}
          </span>
        )}
        <span>
          · {channel ? `#${channel} · ` : ""}
          {relativeTime(t, i18n.language, a.createdAt)}
        </span>
        <span className="ap-grow" />
        {!running && (
          <Chip icon="clock" tone={leftMs <= URGENT_MS ? "waiting" : "neutral"}>
            {a.canDecide
              ? expiryText(t, a)
              : waits
                ? t("approval.waitingFor", { name: waits })
                : t("approval.waitingAdmin")}
          </Chip>
        )}
      </div>
      <h3 className="ap-card__title">
        <button type="button" className="ap-card__open" aria-haspopup="dialog" onClick={onOpen}>
          {title}
        </button>
      </h3>
      <div className="ap-card__body">
        <AheadLine approval={a} className="ap-card__ahead" />
        <ExactAction approval={a} max={4} />
        {why && (
          <p className="ap-said ac-iconline">
            <AgentAvatar agentId={a.agentId} name={name} size="xs" />
            <span>
              <Trans i18nKey="approval.said" values={{ name, text: why }} components={{ b: <b /> }} {...TYPED_VALUES} />
            </span>
          </p>
        )}
        <Traits approval={a} />
        {running && <p className="ap-card__running">{t("approvals.running", { context: g.context, name })}</p>}
        {refusing && a.canDecide && <RefuseBox approval={a} agent={agent} onCancel={onCancelRefuse} />}
        {!running && !refusing && a.canDecide && (
          <div className="ap-card__actions">
            <ApproveButton approval={a} />
            <Button size="sm" onClick={onRefuse}>
              {t("approval.refuse")}
            </Button>
            <ApproveAlways approval={a} agent={agent} />
            <span className="ap-grow" />
            {approvalRisk(a) === "high" && <span className="ap-card__hint">{t("approvals.highRisk")}</span>}
            <Button variant="ghost" size="sm" aria-haspopup="dialog" onClick={onOpen}>
              {t("approvals.details")}
            </Button>
          </div>
        )}
      </div>
      {running ? (
        <WorkSweep color={colorOf(agent)} />
      ) : (
        <ExpiryFuse left={Math.max(0, leftMs) / TTL_MS} color={colorOf(agent)} />
      )}
    </article>
  );
}

function PhaseChip({ approval }: { approval: Approval }) {
  const { t } = useTranslation();
  const p = approvalPhase(approval);
  const [icon, key]: [IconName, "approved" | "failed" | "refused" | "expired" | "running" | "canceled" | "scheduled"] =
    p === "done"
      ? ["check", "approved"]
      : p === "scheduled"
        ? ["calendar", "scheduled"]
        : p === "failed"
          ? ["alert", "failed"]
          : p === "refused"
            ? ["close", "refused"]
            : p === "expired"
              ? ["clock", "expired"]
              : p === "running"
                ? ["play", "running"]
                : ["block", "canceled"];
  return (
    <Chip icon={icon} className={`ap-phase ap-phase--${p}`}>
      {t(`approvals.status.${key}`)}
    </Chip>
  );
}

function HistoryRow({ approval: a, selected, onOpen }: { approval: Approval; selected: boolean; onOpen: () => void }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const agent = dir.agentById.get(a.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const p = approvalPhase(a);
  const fresh = a.decidedAt && Date.now() - new Date(a.decidedAt).getTime() < 8000;
  const sub =
    p === "expired"
      ? (aheadEndLine(t, a) ?? t("approvals.expiredLine"))
      : p === "canceled" && !a.runAt
        ? t("approvals.canceledLine")
        : [
            decisionLabel(t, i18n.language, a, me.user.id, dir.memberById),
            p === "scheduled" && a.runAt
              ? t("approval.ahead.scheduled", { when: nextLabel(i18n.language, a.runAt) })
              : "",
            p === "refused" && a.reason ? `“${a.reason}”` : "",
          ]
            .filter(Boolean)
            .join(" · ");
  return (
    // biome-ignore lint/a11y/useSemanticElements: a row that opens the details
    <div
      className={cx("ap-row", selected && "is-selected", fresh && "is-fresh")}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <AgentAvatar
        agentId={a.agentId}
        name={name}
        size="sm"
        state="idle"
        expression={p === "done" ? "happy" : p === "refused" || p === "expired" ? "closed" : undefined}
      />
      <div className="ap-row__text">
        <b>{approvalTitle(t, a)}</b>
        <small>{sub}</small>
        {p === "refused" && a.reason && (
          <span className="ap-row__lesson">{t("approvals.lesson", { name, reason: a.reason })}</span>
        )}
      </div>
      <div className="ap-row__end">
        {p === "expired" && aheadPhase(a) !== "lapsed" && <AskAgain approval={a} agent={agent} />}
        {p === "scheduled" && a.canCancel && <CancelAhead id={a.id} />}
        <PhaseChip approval={a} />
      </div>
    </div>
  );
}

/** Expired: ask the agent, in the same conversation, to ask again if it still makes sense. */
function AskAgain({ approval, agent }: { approval: Approval; agent: Agent | undefined }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const post = usePostMessage(org.id, approval.channelId, {
    me: { id: me.user.id },
    mentioned: () => [approval.agentId],
    onSent: () => toast.show(t("approvals.againSent"), "info"),
  });
  if (!agent) return null;
  return (
    <Button
      size="sm"
      icon="repeat"
      loading={post.isPending}
      disabled={post.isPending || post.isSuccess}
      onClick={(e) => {
        e.stopPropagation();
        sendHelpers(post).send(
          t("approvals.againBody", { handle: agent.handle, title: approvalTitle(t, approval) }),
          approval.threadId,
        );
      }}
    >
      {t("approvals.again")}
    </Button>
  );
}

/** A request's details over whatever page is open (`DetailsHost`): a routine's run, an audit row. */
export function ApprovalDetailsDialog({ approvalId, onClose }: { approvalId: string; onClose: () => void }) {
  const { org } = useOrg();
  const approvals = useApprovals(org.id);
  const channels = useChannels(org.id);
  const [refusing, setRefusing] = useState(false);
  const all = approvals.data ?? [];
  const approval = all.find((a) => a.id === approvalId);
  useEffect(() => {
    if (approvals.isSuccess && !approval) onClose();
  }, [approvals.isSuccess, approval, onClose]);
  if (!approval) return null;
  return (
    <ApprovalDetails
      approval={approval}
      all={all}
      channel={channels.data?.find((c) => c.id === approval.channelId)?.name ?? ""}
      refusing={refusing}
      onRefuse={() => setRefusing(true)}
      onCancelRefuse={() => setRefusing(false)}
      onClose={onClose}
    />
  );
}

/**
 * A request's details, in the centered details dialog: the exact action, why,
 * how it got here, the agent's record, who decides, and the decision bar.
 */
function ApprovalDetails({
  approval: listed,
  all,
  channel,
  refusing,
  onRefuse,
  onCancelRefuse,
  onClose,
}: {
  approval: Approval;
  all: Approval[];
  channel: string;
  refusing: boolean;
  onRefuse: () => void;
  onCancelRefuse: () => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const roles = useRoles(org.id).data?.roles ?? [];
  const detail = useApproval(org.id, listed.id);
  // The list (kept fresh by events) wins for the state; the detail adds the trail.
  const a: Approval = { ...listed, trail: detail.data?.trail ?? listed.trail };
  const agent = dir.agentById.get(a.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const g = agentGrammar(name);
  const p = approvalPhase(a);
  const kind = approvalAction(a);
  const record = all
    .filter(
      (x) =>
        x.agentId === a.agentId &&
        x.id !== a.id &&
        approvalAction(x) === kind &&
        (x.status === "approved" || x.status === "refused"),
    )
    .sort((x, y) => decidedAt(x).localeCompare(decidedAt(y)))
    .slice(-12);
  const ok = record.filter((x) => x.status === "approved").length;
  const ownerId = a.ownerUserId ?? agent?.ownerUserId ?? null;
  // What a person's roles give them, `everyone`'s included (ADR 0085); owners may everything.
  const everyone = everyoneOf(roles);
  const keysOf = (m: Member) =>
    grants([
      ...(everyone?.permissions ?? []),
      ...roles.filter((r) => m.roleIds?.includes(r.id)).flatMap((r) => r.permissions),
    ]);
  const isAdmin = (m: Member) => m.role === "owner" || keysOf(m).has("administrator");
  const deciding = approvalDecidingKeys(a);
  const holds = (m: Member) => m.role === "owner" || deciding.every((k) => keysOf(m).has(k));
  // A request to turn on access is decided only by those who give it, its agent's owner too.
  const ownerDecides = (m: Member) => a.tool !== "request_permission" || holds(m);
  const deciders = [
    ...dir.members.filter((m) => m.userId === ownerId && ownerDecides(m)),
    ...dir.members.filter((m) => m.userId !== ownerId && holds(m)),
  ].slice(0, 6);
  const pr = prLink(a);
  const decides = p === "waiting" && a.canDecide;
  return (
    <DetailsDialog
      open
      onOpenChange={(o) => !o && onClose()}
      // Esc while a reason is being typed backs out of refusing first.
      onEscapeKeyDown={(e) => {
        if (refusing) {
          e.preventDefault();
          onCancelRefuse();
        }
      }}
      closeLabel={t("approvals.panel.close")}
      className="ap-dialog"
      eyebrow={t("approvals.panel.eyebrow")}
      icon={
        <AgentAvatar
          agentId={a.agentId}
          name={name}
          size="md"
          state={p === "running" ? "writing" : p === "waiting" ? "waiting" : "idle"}
          running={p === "running"}
          expression={p === "done" ? "happy" : undefined}
        />
      }
      title={approvalTitle(t, a)}
      subtitle={
        <>
          <span>
            <b className="ap-dialog__who">{name}</b> {t(`approvals.verb.${kind}`)}
          </span>
          <span>
            {agent?.role ? `${agent.role} · ` : ""}
            {channel ? `#${channel} · ` : ""}
            {relativeTime(t, i18n.language, a.createdAt)}
          </span>
        </>
      }
      footer={
        decides && (
          <div className="ap-decide">
            {refusing ? (
              <RefuseBox approval={a} agent={agent} onCancel={onCancelRefuse} />
            ) : (
              <>
                <div className="ap-decide__buttons">
                  <Button onClick={onRefuse}>
                    {t("approval.refuse")}
                    <Kbd>R</Kbd>
                  </Button>
                  <ApproveButton approval={a} block />
                </div>
                <p className="ap-muted ap-center">
                  {approvalRisk(a) === "high"
                    ? t("approvals.holdNote")
                    : a.runAt
                      ? t("approvals.clickNoteAhead", { when: nextLabel(i18n.language, a.runAt) })
                      : t("approvals.clickNote")}
                </p>
                {approveAlwaysOffered(a) && (
                  <div className="ap-decide__always">
                    <ApproveAlways approval={a} agent={agent} />
                  </div>
                )}
              </>
            )}
          </div>
        )
      }
    >
      <AheadLine approval={a} className="ap-card__ahead" />
      {p === "waiting" && (
        <div className="ap-traits">
          <Chip icon="clock">{expiryText(t, a)}</Chip>
          {approvalTraits(a).map((k) => (
            <Chip key={k} icon={TRAIT_ICON[k]}>
              {t(`approvals.trait.${k}`)}
            </Chip>
          ))}
        </div>
      )}

      {p !== "waiting" && <Outcome approval={a} agent={agent} />}

      <ApprovalOrigin approval={a} />
      {approvalWhy(a) && (
        <DetailsSection title={t("approvals.panel.why")}>
          <p className="ap-bubble">{approvalWhy(a)}</p>
          {a.issue && (
            <Link
              className="ap-link"
              to="/org/$orgId/issues/$number"
              params={{ orgId: org.id, number: String(a.issue.number) }}
            >
              #{a.issue.number} {a.issue.title}
            </Link>
          )}
        </DetailsSection>
      )}

      <DetailsSection title={t("approvals.panel.exact")}>
        {/* Values in words; nested values and the tool's own name behind "Detalhes técnicos". */}
        <ExactAction approval={a} />
        <p className="ap-bound">{t("approvals.panel.bound")}</p>
        {pr && (
          <a className="ap-link" href={pr} target="_blank" rel="noreferrer">
            {t("approvals.panel.openPr")}
          </a>
        )}
      </DetailsSection>

      {(a.trail?.length ?? 0) > 1 && (
        <DetailsSection title={t("approvals.panel.trail")}>
          <ol className="ap-trail">
            {a.trail?.map((s) => (
              <li key={s.at + s.text.slice(0, 12)} className="ac-iconline">
                <span className="ap-trail__dot" aria-hidden="true" />
                <span className="ap-trail__text">{s.text}</span>
                <time dateTime={s.at}>{relativeTime(t, i18n.language, s.at)}</time>
              </li>
            ))}
            <li className="is-current ac-iconline">
              <span className="ap-trail__dot" aria-hidden="true" />
              <span className="ap-trail__text">{t("approvals.panel.asked")}</span>
              <time dateTime={a.createdAt}>{relativeTime(t, i18n.language, a.createdAt)}</time>
            </li>
          </ol>
        </DetailsSection>
      )}
      {channel && (
        <Link
          className="ap-link"
          to="/org/$orgId/c/$channelId"
          params={{ orgId: org.id, channelId: a.channelId }}
          search={{ m: a.messageId ?? a.threadId ?? undefined }}
        >
          {t("approvals.panel.viewChannel", { channel })}
        </Link>
      )}

      <DetailsSection title={t("approvals.panel.history", { context: g.context, name })}>
        {record.length > 0 ? (
          <div className="ap-record">
            <span role="img" aria-label={t("approvals.panel.historyCount", { ok, count: record.length })}>
              <CriteriaPixels done={record.map((x) => x.status === "approved")} color={colorOf(agent)} />
            </span>
            <span>{t("approvals.panel.historyCount", { ok, count: record.length })}</span>
          </div>
        ) : (
          <p className="ap-muted">{t("approvals.panel.noHistory")}</p>
        )}
      </DetailsSection>

      {p === "waiting" && (
        <DetailsSection title={t("approvals.panel.deciders")}>
          {a.approvers ? (
            // Asked of named people or a role (ADR 0126): they decide, never the requester unless by role.
            <ul className="ap-deciders">
              <li>
                <span className="ap-person" aria-hidden="true">
                  {(a.approvers.label.trim()[0] ?? "?").toUpperCase()}
                </span>
                <span>{a.approvers.label}</span>
              </li>
            </ul>
          ) : (
            <ul className="ap-deciders">
              {deciders.map((m) => (
                <li key={m.userId}>
                  <span className="ap-person" aria-hidden="true">
                    {(m.name.trim()[0] ?? "?").toUpperCase()}
                  </span>
                  <span>
                    {m.userId === me.user.id ? t("approvals.panel.you") : m.name}
                    <small>
                      {" · "}
                      {[
                        m.userId === ownerId ? t("approvals.panel.owner") : "",
                        isAdmin(m) ? t("approvals.panel.admin") : "",
                      ]
                        .filter(Boolean)
                        .join(", ")}
                    </small>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {requesterDecidesLine(t, a) && <p className="ap-muted">{requesterDecidesLine(t, a)}</p>}
          {channel && <p className="ap-muted">{t("approvals.panel.firstWins", { channel })}</p>}
        </DetailsSection>
      )}
    </DetailsDialog>
  );
}

function Outcome({ approval: a, agent }: { approval: Approval; agent: Agent | undefined }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const name = agent?.name ?? t("channel.unknownAgent");
  const g = agentGrammar(name);
  const p = approvalPhase(a);
  const who =
    a.decidedByUserId === me.user.id
      ? t("approvals.panel.youLower")
      : (dir.memberById.get(a.decidedByUserId ?? "")?.name ?? "");
  const when = a.decidedAt ? relativeTime(t, i18n.language, a.decidedAt) : "";
  return (
    <div className={cx("ap-outcome", `ap-outcome--${p}`)}>
      <PhaseChip approval={a} />
      <div className="ap-outcome__text">
        {p === "running" && <b>{t("approvals.panel.runningLine", { context: g.context, name })}</b>}
        {(p === "done" || p === "failed") && (
          <>
            <b>{p === "done" ? t("approvals.panel.done") : t("approvals.panel.failed")}</b>
            <small>{t("approvals.panel.approvedBy", { name: who, when })}</small>
          </>
        )}
        {p === "refused" && (
          <>
            <b>{t("approvals.panel.refusedBy", { name: who, when })}</b>
            <small>{a.reason ? `“${a.reason}”` : t("approvals.panel.noReason")}</small>
            {a.reason && <small className="ap-row__lesson">{t("approvals.lesson", { name, reason: a.reason })}</small>}
          </>
        )}
        {p === "scheduled" && a.runAt && (
          <>
            <b>{t("approval.ahead.scheduled", { when: nextLabel(i18n.language, a.runAt) })}</b>
            <small>{t("approvals.panel.approvedBy", { name: who, when })}</small>
            {a.canCancel && (
              <span className="ac-acts">
                <CancelAhead id={a.id} />
              </span>
            )}
          </>
        )}
        {p === "expired" && (
          <>
            <b>{t("approvals.status.expired")}</b>
            <small>{aheadEndLine(t, a) ?? t("approvals.expiredLine")}</small>
            {aheadPhase(a) !== "lapsed" && (
              <span>
                <AskAgain approval={a} agent={agent} />
              </span>
            )}
          </>
        )}
        {p === "canceled" && <small>{aheadEndLine(t, a) ?? t("approvals.canceledLine")}</small>}
      </div>
      {a.result?.text && (
        <details className="ap-result">
          <summary>{t("approvals.panel.returned")}</summary>
          <pre className="ap-code">
            <code>{a.result.text}</code>
          </pre>
        </details>
      )}
      {p === "running" && <WorkSweep color={colorOf(agent)} />}
    </div>
  );
}
