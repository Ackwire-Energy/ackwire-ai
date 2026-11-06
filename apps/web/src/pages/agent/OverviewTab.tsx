import { useAgentDetail, useChannels, useProposals, useRuns } from "@agenteschat/client";
import { whenAt } from "@agenteschat/client/lib/format";
import { proposalTitle } from "@agenteschat/client/lib/proposals";
import { excerpt } from "@agenteschat/client/lib/text";
import { Button, Card, Icon } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { CardHead, useAgentEdit } from "./context";
import { Ficha } from "./Ficha";
import { ReadOnlyNote, RunIcon, runWhere } from "./pieces";

/** "What it does": the start of its instructions in plain words, up to three lines and this many characters. */
const DOES_PREVIEW = 280;

/** Recent work: its latest runs (Activity has the rest). */
const RECENT = 3;

/**
 * Overview, one column: what waits on someone, what it does, the Ficha (how it works and who it works with, each
 * row opening its dialog) and its recent work.
 */
export function OverviewTab() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const { agent, g, viewer, goTo, can, ownerFirst } = useAgentEdit();
  const detail = useAgentDetail(org.id, agent.id);
  const proposals = useProposals(org.id);
  const runs = useRuns(org.id, agent.id, viewer !== "member");
  const channels = useChannels(org.id);
  const pending = (proposals.data ?? []).filter(
    (p) => p.agentId === agent.id && p.status === "pending" && p.target.type === "agent_instructions",
  );
  const approvals = detail.data?.pendingApprovals ?? 0;
  const recent = (runs.data ?? []).slice(0, RECENT);
  const decides = viewer !== "member";
  return (
    <>
      <ReadOnlyNote />
      <div className="agp-col agp-overview">
        {(approvals > 0 || pending.length > 0) && (
          <div className="agp-attns">
            {approvals > 0 && (
              <div className="agp-attn ac-faceline">
                <span className="agp-ib agp-ib--warn">
                  <Icon name="lock" size={16} />
                </span>
                <span className="agp-attn__t">
                  <b className="ac-captop">{t("agentPage.overview.approvals", { count: approvals })}</b>
                  <span>{decides ? t("agentPage.overview.approvalsYou") : t("agentPage.overview.approvalsWait")}</span>
                </span>
                <span className="agp-attn__tail ac-captop">
                  <Button asChild size="sm">
                    <Link to="/org/$orgId/approvals" params={{ orgId: org.id }}>
                      {t("agentPage.overview.seeApprovals")}
                    </Link>
                  </Button>
                </span>
              </div>
            )}
            {pending.map((p) => (
              <div key={p.id} className="agp-attn ac-faceline">
                <span className="agp-ib agp-ib--warn">
                  <Icon name="document" size={16} />
                </span>
                <span className="agp-attn__t">
                  <b className="ac-captop">{t("agentPage.overview.proposes", g)}</b>
                  <span>
                    {proposalTitle(t, p, org.name, (id) => dir.agentById.get(id)?.name ?? agent.name)} ·{" "}
                    {p.canDecide
                      ? t("approval.waitingYou")
                      : p.decider.type === "user"
                        ? t("proposals.waitingFor", { name: p.decider.name })
                        : t("proposals.waitingAdmin")}
                  </span>
                </span>
                <span className="agp-attn__tail ac-captop">
                  <Button size="sm" onClick={() => goTo("memory")}>
                    {t("agentPage.overview.review")}
                  </Button>
                </span>
              </div>
            ))}
          </div>
        )}

        <Card as="section" className="agp-card" aria-labelledby="ov-does">
          <CardHead
            id="ov-does"
            icon="document"
            title={t("agentPage.overview.does", g)}
            hint={{
              name: t("common.about", { label: t("agentPage.overview.does", g) }),
              text: t("agent.instructionsHelp", { ...g, org: org.name }),
            }}
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
        </Card>

        <Ficha />

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
                <li key={r.id} className="agp-li ac-faceline">
                  <RunIcon run={r} />
                  <span className="agp-li__t">
                    <b className="ac-captop">{r.private ? t("agent.runPrivate") : r.what || t("agent.runNoText")}</b>
                    <span>
                      {runWhere(t, r, channels.data ?? [])}
                      {r.repo ? ` · ${r.repo}` : ""}
                    </span>
                  </span>
                  <span className="agp-li__tail ac-captop">
                    <span className="agp-li__when">{whenAt(t, locale, r.createdAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
