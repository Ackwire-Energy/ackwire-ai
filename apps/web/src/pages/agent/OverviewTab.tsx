import { Avatar, Button, Card, Chip, Icon, Meter } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  useAgentDetail,
  useAgentSkills,
  useChannels,
  useModels,
  useProposals,
  useRoutines,
  useRuns,
  useSettings,
  useUsage,
} from "@/api/queries";
import { ResourceIcon, resourceName, toolLabel, useConnectedById } from "@/components/AccessLevels";
import { usd } from "@/components/AgentFields";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { asksAt } from "@/lib/access-levels";
import { audienceSummary } from "@/lib/audience";
import { formatMonth, formatPercent, formatUsd, joinNames, whenAt } from "@/lib/format";
import { proposalTitle } from "@/pages/ProposalsPage";
import { CardHead, useAgentEdit } from "./context";
import { ReadOnlyNote, RunIcon, runWhere } from "./pieces";

/** Visão geral: what it does, its recent work, what it can use; who answers, where it works, model and budget. */
export function OverviewTab() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const { agent, g, viewer, saved, goTo, can, resources, ownerFirst } = useAgentEdit();
  const detail = useAgentDetail(org.id, agent.id);
  const proposals = useProposals(org.id);
  const runs = useRuns(org.id, agent.id, viewer !== "member");
  const channels = useChannels(org.id);
  const skills = useAgentSkills(org.id, agent.id);
  const routines = useRoutines(org.id);
  const models = useModels();
  const usage = useUsage(org.id);
  const settings = useSettings(org.id);
  const items = useConnectedById();
  const pending = (proposals.data ?? []).filter(
    (p) => p.agentId === agent.id && p.status === "pending" && p.target.type === "agent_instructions",
  );
  const approvals = detail.data?.pendingApprovals ?? 0;
  const owner = agent.ownerUserId ? dir.memberById.get(agent.ownerUserId) : undefined;
  const levels = saved.levels ?? {};
  const using = resources.filter((r) => (levels[r.id] ?? "none") !== "none");
  const connectors = using.filter((r) => r.kind === "connector");
  const builtins = using.filter((r) => r.kind === "builtin");
  const asks = connectors.flatMap((r) => asksAt(r, levels[r.id] ?? "none").map((x) => toolLabel(t, r, x)));
  const enabledSkills = (skills.data ?? []).filter((s) => s.enabled);
  const mine = (routines.data ?? []).filter((r) => r.agentId === agent.id);
  const recent = (runs.data ?? []).slice(0, 4);
  const modelLabel = models.data?.models.find((m) => m.id === saved.model)?.label ?? saved.model;
  const used = detail.data?.budgetUsedPercent ?? 0;
  const spent = usage.data?.find((u) => u.agentId === agent.id)?.costUsd;
  const limit = detail.data?.monthlyBudgetUsd ?? detail.data?.defaultBudgetUsd;
  const ownKey = detail.data?.credentialId && detail.data.credentialId !== settings.data?.defaultCredentialId;
  const keyLabel = ownKey
    ? t("agent.ownKey")
    : agent.hasCredential
      ? t("agent.withOrgKey", { org: org.name })
      : t("agent.withPlatformKey");
  const decides = viewer !== "member";
  return (
    <>
      <ReadOnlyNote />
      <div className="agp-cols">
        <div className="agp-col">
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
              <p className="agp-prose agp-clamp">{agent.instructions}</p>
            ) : (
              <p className="muted">{t("agent.noInstructions", g)}</p>
            )}
            <span className="small muted">{t("agent.instructionsHelp", { org: org.name })}</span>
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
                      <span>{runWhere(t, r, channels.data ?? [])}</span>
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
                          {t(levels[r.id] === "write" ? "newAgent.preview.readsWrites" : "newAgent.preview.reads", {
                            name: n,
                          })}
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
            {asks.length > 0 && (
              <p className="small muted agp-inline">
                <Icon name="lock" size={14} />
                {t("agentPage.overview.asks", {
                  actions: joinNames([...new Set(asks)], t("newAgent.and")),
                  who: ownerFirst ?? t("roles.adminLower"),
                })}
              </p>
            )}
          </Card>
        </div>

        <div className="agp-col">
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

          <Card as="section" className="agp-card" aria-labelledby="ov-model">
            <CardHead
              id="ov-model"
              icon="bolt"
              title={t("agentPage.overview.modelBudget")}
              action={
                can("model") ? (
                  <Button size="sm" variant="ghost" icon="edit" onClick={() => goTo("settings", "model")}>
                    {t("agentPage.change")}
                  </Button>
                ) : null
              }
            />
            <span className="agp-chips">
              <Chip icon="bolt">{modelLabel}</Chip>
              <Chip icon="key">{keyLabel}</Chip>
            </span>
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
