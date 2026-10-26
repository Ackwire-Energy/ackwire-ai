import {
  useAgentDetail,
  useAgentSkills,
  useChannels,
  useProposals,
  useRoutines,
  useRuns,
  useUsage,
} from "@agenteschat/client";
import { audienceSummary } from "@agenteschat/client/lib/audience";
import { formatMonth, formatPercent, formatUsd, whenAt } from "@agenteschat/client/lib/format";
import { excerpt } from "@agenteschat/client/lib/text";
import { Avatar, Button, Card, CardFooter, Chip, Icon, Meter } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ResourceIcon, resourceName, useConnectedById } from "@/components/AccessLevels";
import { usd } from "@/components/AgentFields";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { proposalTitle } from "@/pages/ProposalsPage";
import { AgentAsksLine, agentConnectorTools } from "./AgentTools";
import { ComputerNow } from "./ComputerNow";
import { CardHead, useAgentEdit } from "./context";
import { Numbers } from "./Hero";
import { ReadOnlyNote, RunIcon, runWhere } from "./pieces";
import { useRepoSuffix } from "./Repos";
import { WorkCard } from "./Work";

/** "What it does": the start of its instructions in plain words, up to three lines and this many characters. */
const DOES_PREVIEW = 280;

/** Visão geral: what it does, its recent work, what it can use; who answers, where it works, who thinks and the budget. */
export function OverviewTab() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const { agent, g, viewer, saved, goTo, can, resources, ownerFirst, openWork, workInAside } = useAgentEdit();
  const detail = useAgentDetail(org.id, agent.id);
  const proposals = useProposals(org.id);
  const runs = useRuns(org.id, agent.id, viewer !== "member");
  const channels = useChannels(org.id);
  const skills = useAgentSkills(org.id, agent.id);
  const routines = useRoutines(org.id);
  const usage = useUsage(org.id);
  const items = useConnectedById();
  const repoSuffix = useRepoSuffix();
  const pending = (proposals.data ?? []).filter(
    (p) => p.agentId === agent.id && p.status === "pending" && p.target.type === "agent_instructions",
  );
  const approvals = detail.data?.pendingApprovals ?? 0;
  const owner = agent.ownerUserId ? dir.memberById.get(agent.ownerUserId) : undefined;
  const levels = saved.levels ?? {};
  const using = resources.filter((r) => (levels[r.id] ?? "none") !== "none");
  const connectors = using.filter((r) => r.kind === "connector");
  const builtins = using.filter((r) => r.kind === "builtin");
  const connectorTools = agentConnectorTools(t, connectors, levels, items);
  const enabledSkills = (skills.data ?? []).filter((s) => s.enabled);
  const mine = (routines.data ?? []).filter((r) => r.agentId === agent.id);
  const recent = (runs.data ?? []).slice(0, 4);
  const used = detail.data?.budgetUsedPercent ?? 0;
  const spent = usage.data?.find((u) => u.agentId === agent.id)?.costUsd;
  const limit = detail.data?.monthlyBudgetUsd ?? detail.data?.defaultBudgetUsd;
  const decides = viewer !== "member";
  return (
    <>
      <ReadOnlyNote />
      <div className="agp-cols">
        <div className="agp-col">
          <ComputerNow />
          {(approvals > 0 || pending.length > 0) && (
            <div className="agp-attns">
              {approvals > 0 && (
                <div className="agp-attn">
                  <span className="agp-ib agp-ib--warn">
                    <Icon name="lock" size={16} />
                  </span>
                  <span className="agp-attn__t">
                    <b>{t("agentPage.overview.approvals", { count: approvals })}</b>
                    <span>
                      {decides ? t("agentPage.overview.approvalsYou") : t("agentPage.overview.approvalsWait")}
                    </span>
                  </span>
                  <Button asChild size="sm">
                    <Link to="/org/$orgId/approvals" params={{ orgId: org.id }}>
                      {t("agentPage.overview.seeApprovals")}
                    </Link>
                  </Button>
                </div>
              )}
              {pending.map((p) => (
                <div key={p.id} className="agp-attn">
                  <span className="agp-ib agp-ib--warn">
                    <Icon name="document" size={16} />
                  </span>
                  <span className="agp-attn__t">
                    <b>{t("agentPage.overview.proposes", g)}</b>
                    <span>
                      {proposalTitle(t, p, org.name, (id) => dir.agentById.get(id)?.name ?? agent.name)} ·{" "}
                      {p.canDecide
                        ? t("approval.waitingYou")
                        : p.decider.type === "user"
                          ? t("proposals.waitingFor", { name: p.decider.name })
                          : t("proposals.waitingAdmin")}
                    </span>
                  </span>
                  <Button size="sm" onClick={() => goTo("memory")}>
                    {t("agentPage.overview.review")}
                  </Button>
                </div>
              ))}
            </div>
          )}

          <Card as="section" className="agp-card" aria-labelledby="ov-does">
            <CardHead
              id="ov-does"
              icon="document"
              title={t("agentPage.overview.does", g)}
              action={
                <Button
                  size="sm"
                  variant="ghost"
                  icon={can("instructions") ? "edit" : undefined}
                  onClick={() => goTo("instructions")}
                >
                  {can("instructions") ? t("agent.edit") : t("agentPage.overview.readAll")}
                </Button>
              }
            />
            {agent.instructions.trim() ? (
              <p className="agp-prose">{excerpt(agent.instructions, DOES_PREVIEW)}</p>
            ) : (
              <p className="muted">{t("agent.noInstructions", g)}</p>
            )}
            <CardFooter>{t("agent.instructionsHelp", { org: org.name })}</CardFooter>
          </Card>

          <Card as="section" className="agp-card" aria-labelledby="ov-recent">
            <CardHead
              id="ov-recent"
              icon="routines"
              title={t("agentPage.overview.recent")}
              action={
                decides ? (
                  <Button size="sm" variant="ghost" onClick={() => goTo("activity")}>
                    {t("agentPage.overview.seeAll")}
                  </Button>
                ) : null
              }
            />
            {!decides ? (
              <p className="small muted">
                {t("agentPage.activity.hidden", { owner: ownerFirst ?? t("roles.adminLower") })}
              </p>
            ) : recent.length === 0 ? (
              <p className="small muted">{t("agent.runsNone")}</p>
            ) : (
              <ul className="agp-list">
                {recent.map((r) => (
                  <li key={r.id} className="agp-li">
                    <RunIcon run={r} />
                    <span className="agp-li__t">
                      <b>{r.what || t("agent.runNoText")}</b>
                      <span>
                        {runWhere(t, r, channels.data ?? [])}
                        {r.repo ? ` · ${r.repo}` : ""}
                      </span>
                    </span>
                    <span className="agp-li__when">{whenAt(t, locale, r.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card as="section" className="agp-card" aria-labelledby="ov-uses">
            <CardHead
              id="ov-uses"
              icon="plug"
              title={t("agentPage.overview.uses")}
              action={
                <Button
                  size="sm"
                  variant="ghost"
                  icon={can("levels") ? "edit" : undefined}
                  onClick={() => goTo("access")}
                >
                  {can("levels") ? t("agentPage.overview.changeAccess") : t("agentPage.overview.seeAccess")}
                </Button>
              }
            />
            <div className="agp-kv">
              <div>
                <span className="agp-k">{t("access.kind.connectors")}</span>
                {connectors.length ? (
                  <span className="agp-chips">
                    {connectors.map((r) => {
                      const n = resourceName(t, r, items);
                      return (
                        <span key={r.id} className="ac-chip agp-res">
                          <ResourceIcon resource={r} items={items} name={n} />
                          {t(
                            levels[r.id] === "write"
                              ? "agentPage.overview.levelWrite"
                              : levels[r.id] === "custom"
                                ? "agentPage.overview.levelCustom"
                                : "agentPage.overview.levelRead",
                            { name: n },
                          )}
                          {r.connector === "github" && repoSuffix}
                        </span>
                      );
                    })}
                  </span>
                ) : (
                  <span className="small muted">{t("agentPage.overview.noConnectors")}</span>
                )}
              </div>
              <div>
                <span className="agp-k">{t("access.kind.builtin")}</span>
                <span className="agp-chips">
                  {builtins.slice(0, 5).map((r) => {
                    const n = resourceName(t, r, items);
                    return (
                      <span key={r.id} className="ac-chip agp-res">
                        <ResourceIcon resource={r} items={items} name={n} />
                        {n}
                      </span>
                    );
                  })}
                  {builtins.length > 5 && (
                    <button type="button" className="ac-chip agp-more-chip" onClick={() => goTo("access")}>
                      {t("agentPage.overview.andMore", { count: builtins.length - 5 })}
                    </button>
                  )}
                </span>
              </div>
              {enabledSkills.length > 0 && (
                <div>
                  <span className="agp-k">{t("skills.agentTitle")}</span>
                  <span className="agp-chips">
                    {enabledSkills.map((s) => (
                      <Chip key={s.id} icon="book">
                        {s.name}
                      </Chip>
                    ))}
                  </span>
                </div>
              )}
            </div>
            <AgentAsksLine
              agentName={agent.name}
              groups={connectorTools}
              items={items}
              canChange={can("levels")}
              onChange={() => goTo("access")}
            />
          </Card>
        </div>

        {/* The quiet side column: how it works and its numbers, then who and where. */}
        <div className="agp-col agp-aside">
          {workInAside && (
            // The card inside is the "Como trabalha" region; this only gives it its quiet heading.
            <div className="agp-aside__work">
              <p className="agp-aside__h" aria-hidden="true">
                {t("agentPage.work.cell.label")}
              </p>
              <WorkCard onOpen={openWork} footer={<Numbers />} />
            </div>
          )}
          <Card as="section" className="agp-card" aria-labelledby="ov-who">
            <CardHead
              id="ov-who"
              icon="person"
              title={t("agentPage.overview.who")}
              action={
                can("owner") ? (
                  <Button size="sm" variant="ghost" icon="edit" onClick={() => goTo("settings", "owner")}>
                    {t("agentPage.change")}
                  </Button>
                ) : null
              }
            />
            <div className="agp-person">
              {owner ? (
                <Avatar kind="person" size="lg" name={owner.name} imageUrl={owner.image} />
              ) : (
                <span className="newag__ib">
                  <Icon name="members" size={16} />
                </span>
              )}
              <span className="agp-person__t">
                <b>
                  {owner
                    ? owner.userId === me.user.id
                      ? t("newAgent.you", { name: owner.name })
                      : owner.name
                    : t("newAgent.noOwnerOption")}
                </b>
                <span>{owner ? t("agentPage.overview.ownerRole") : t("newAgent.noOwnerHelp")}</span>
              </span>
            </div>
            <div className="agp-kv">
              <div>
                <span className="agp-k">{t("audience.section")}</span>
                <span className="agp-chips">
                  <Chip icon="message">{audienceSummary(t, agent, (id) => dir.memberById.get(id)?.name)}</Chip>
                </span>
              </div>
            </div>
          </Card>

          <Card as="section" className="agp-card" aria-labelledby="ov-where">
            <CardHead
              id="ov-where"
              icon="channel"
              title={t("agentPage.overview.where")}
              action={
                can("channels") ? (
                  <Button size="sm" variant="ghost" icon="edit" onClick={() => goTo("settings", "channels")}>
                    {t("agentPage.change")}
                  </Button>
                ) : null
              }
            />
            {(detail.data?.channels ?? []).filter((c) => saved.channels?.includes(c.id) ?? true).length ? (
              <span className="agp-chips">
                {(detail.data?.channels ?? [])
                  .filter((c) => saved.channels?.includes(c.id) ?? true)
                  .map((c) => (
                    <Chip key={c.id} icon="channel">
                      {c.name}
                    </Chip>
                  ))}
              </span>
            ) : (
              <span className="small muted">{t("agentPage.overview.noChannels", { handle: agent.handle })}</span>
            )}
            {mine.length > 0 && (
              <div className="agp-kv">
                <div>
                  <span className="agp-k">{t("agentPage.overview.routines")}</span>
                  <ul className="agp-list">
                    {mine.map((r) => (
                      <li key={r.id} className="agp-li">
                        <span className="agp-ib">
                          <Icon name="routines" size={14} />
                        </span>
                        <span className="agp-li__t">
                          <b>{r.name}</b>
                          <span>
                            {r.nextRunAt
                              ? t("agentPage.overview.nextRun", { when: whenAt(t, locale, r.nextRunAt) })
                              : t("agentPage.overview.paused")}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </Card>

          {/* Who thinks is the sentence under the name; here, the money. */}
          <Card as="section" className="agp-card" aria-labelledby="ov-budget">
            <CardHead
              id="ov-budget"
              icon="wallet"
              title={t("agentPage.settings.budget")}
              action={
                can("budget") ? (
                  <Button size="sm" variant="ghost" icon="edit" onClick={() => goTo("settings", "budget")}>
                    {t("agentPage.change")}
                  </Button>
                ) : null
              }
            />
            <div className="agp-budget">
              <span className="small muted">
                {viewer === "admin" && spent !== undefined && limit !== undefined
                  ? t("agentPage.overview.spentOf", {
                      spent: formatUsd(t, locale, spent),
                      limit: usd(t, locale, limit),
                      month: formatMonth(locale, new Date()),
                    })
                  : t(
                      detail.data?.monthlyBudgetUsd === null
                        ? "agentPage.overview.percentDefault"
                        : "agentPage.overview.percent",
                      {
                        percent: formatPercent(locale, used),
                      },
                    )}
              </span>
              <Meter value={Math.min(100, used)} max={100} label={t("agent.budgetUsed")} />
              <span className="small muted">
                {viewer === "admin"
                  ? ownerFirst
                    ? t("agentPage.overview.warnsOwner", { name: ownerFirst })
                    : t("agentPage.overview.warnsAdmins")
                  : t("agent.usageHidden")}
              </span>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
