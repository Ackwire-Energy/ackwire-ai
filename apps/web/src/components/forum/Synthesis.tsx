import type {
  ForumDecisionCards,
  ForumOwner,
  ForumPlanCards,
  ForumSynthesisCards,
  ForumTopicDetail,
} from "@agenteschat/client";
import { useForumAction } from "@agenteschat/client";
import { issuesWithState, ownerOf } from "@agenteschat/client/lib/forum";
import { Button, Checkbox, Icon } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import { ArtifactCard } from "@/components/artifacts/ArtifactCard";
import { useOrg } from "@/components/org-context";
import { SaveToWikiDialog } from "@/components/SaveToWiki";
import { useWikiLinkRenderer } from "@/components/WikiLinks";
import { Markdown, renderInline } from "@/lib/markdown";
import { useToast } from "@/lib/toast";
import { OriginLink, SeatAvatar, useForumWho } from "./pieces";

/** The headline of a synthesis: the decision, or the plan's objective. */
export const headlineOf = (s: ForumSynthesisCards) => (s.format === "plan" ? s.objective : s.decision);

function OwnerLine({ owner, label }: { owner: ForumOwner | null; label: string | null }) {
  const who = useForumWho();
  if (!owner) return label ? <span>{label}</span> : null;
  const name = owner.type === "agent" ? who.agentName(owner.id) : who.personName(owner.id);
  return (
    <span className="forum-owner">
      <ActorAvatar actor={owner} name={name || label || ""} size="xs" />
      {name || label}
    </span>
  );
}

function List({ items, icon }: { items: string[]; icon: "plus" | "dash" | "alert" | "flag" | "question" }) {
  return (
    <ul className="forum-ol">
      {items.map((x) => (
        <li key={x}>
          <span className="forum-ol__k">
            <Icon name={icon} size={14} />
          </span>
          <span>{renderInline(x, x)}</span>
        </li>
      ))}
    </ul>
  );
}

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="forum-ss">
      <h3>
        {title}
        {aside && (
          <>
            <span className="forum-grow" />
            <span className="forum-ss__count">{aside}</span>
          </>
        )}
      </h3>
      {children}
    </div>
  );
}

function DecisionBody({ s }: { s: ForumDecisionCards }) {
  const { t } = useTranslation();
  const who = useForumWho();
  return (
    <>
      {s.reasons && s.reasons.length > 0 && (
        <Section title={t("forum.synthesis.why")}>
          <List items={s.reasons} icon="flag" />
        </Section>
      )}
      {s.positions.length > 0 && (
        <Section title={t("forum.synthesis.prosCons")}>
          {s.positions.map((p) => (
            <div key={`${p.agentId ?? p.name}`} className="forum-pcr">
              <div className="forum-pcr__w">
                {p.agentId && <SeatAvatar seat={{ type: "agent", id: p.agentId }} size="sm" />}
                <div>
                  {p.agentId ? who.agentName(p.agentId) || p.name : p.name}
                  {p.agentId && <small>{who.dir.agentById.get(p.agentId)?.role}</small>}
                </div>
              </div>
              <div className="forum-pcr__col">
                {p.pros.map((x) => (
                  <span key={x} className="ac-iconline">
                    <Icon name="plus" size={14} />
                    {x}
                  </span>
                ))}
              </div>
              <div className="forum-pcr__col">
                {p.cons.map((x) => (
                  <span key={x} className="ac-iconline">
                    <Icon name="dash" size={14} />
                    {x}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </Section>
      )}
      {(s.openQuestions.length > 0 || s.nextSteps.length > 0) && (
        <div className="forum-twocol">
          {s.openQuestions.length > 0 ? (
            <Section title={t("forum.synthesis.openQuestions")}>
              <List items={s.openQuestions} icon="question" />
            </Section>
          ) : (
            <div />
          )}
          {s.nextSteps.length > 0 && (
            <Section title={t("forum.synthesis.nextSteps")}>
              <ul className="forum-ol">
                {s.nextSteps.map((n) => (
                  <li key={n.text}>
                    <span className="forum-ol__k">
                      <Icon name="arrowRight" size={14} />
                    </span>
                    <span>
                      {n.text}
                      <small>
                        <OwnerLine owner={n.owner} label={n.ownerLabel} />
                        {n.when ? ` · ${n.when}` : ""}
                      </small>
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      )}
    </>
  );
}

function PlanBody({ s, topic }: { s: ForumPlanCards; topic: ForumTopicDetail }) {
  const { t } = useTranslation();
  const who = useForumWho();
  const requester = topic.requestedByUserId;
  const name = who.personName(requester);
  return (
    <>
      {s.summaryForRequester && requester && (
        <div className="forum-forreq">
          <SeatAvatar seat={{ type: "person", id: requester }} size="sm" />
          <span>
            <b>{t("forum.synthesis.forRequester", { name, context: who.g(name).context })}</b> {s.summaryForRequester}
          </span>
        </div>
      )}
      {(s.inScope.length > 0 || s.outOfScope.length > 0) && (
        <div className="forum-twocol">
          <Section title={t("forum.synthesis.inScope")}>
            <List items={s.inScope} icon="plus" />
          </Section>
          <Section title={t("forum.synthesis.outOfScope")}>
            <List items={s.outOfScope} icon="dash" />
          </Section>
        </div>
      )}
      {s.steps.length > 0 && (
        <Section title={t("forum.synthesis.steps")}>
          <ol className="forum-steps">
            {s.steps.map((x, i) => (
              <li key={`${x.title}-${x.owner?.id ?? x.ownerLabel ?? ""}-${x.after ?? 0}`}>
                <span className="forum-steps__k">{i + 1}</span>
                <span className="forum-steps__tx">
                  <b>{x.title}</b>
                  <small>
                    <OwnerLine owner={x.owner} label={x.ownerLabel} />
                    <span>{x.after ? t("forum.synthesis.after", { n: x.after }) : t("forum.synthesis.startNow")}</span>
                  </small>
                </span>
                {x.size && <span className="forum-steps__sz">{x.size}</span>}
              </li>
            ))}
          </ol>
        </Section>
      )}
      {(s.risks.length > 0 || s.metrics.length > 0) && (
        <div className="forum-twocol">
          <Section title={t("forum.synthesis.risks")}>
            <List items={s.risks} icon="alert" />
          </Section>
          <Section title={t("forum.synthesis.metrics")}>
            <List items={s.metrics} icon="flag" />
          </Section>
        </div>
      )}
      {s.openQuestions.length > 0 && (
        <Section title={t("forum.synthesis.openQuestions")}>
          <List items={s.openQuestions} icon="question" />
        </Section>
      )}
    </>
  );
}

/** The issues the synthesis suggests, with checkboxes; "Criar" makes the checked ones (sub-issues of the origin issue). */
function SuggestedIssues({ topic }: { topic: ForumTopicDetail }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const who = useForumWho();
  const toast = useToast();
  const action = useForumAction(org.id);
  const syn = topic.synthesis;
  const list = syn ? issuesWithState(syn) : [];
  const pending = list.filter((x) => !x.created);
  const [off, setOff] = useState<Set<string>>(new Set());
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new synthesis version starts all checked
  useEffect(() => setOff(new Set()), [syn?.revision]);
  if (!syn || list.length === 0) return null;
  const on = pending.filter((x) => !off.has(x.issue.title));
  const parent = topic.origin.kind === "issue" ? topic.origin.issueNumber : null;
  const owner = ownerOf(topic);
  const ownerName = who.agentName(owner);
  const plan = syn.format === "plan";
  const create = () =>
    action.mutate(
      { type: "issues", topicId: topic.id, items: on.map((x) => x.issue) },
      {
        onSuccess: () =>
          toast.show(
            parent
              ? t("forum.synthesis.createdSub", { count: on.length, number: parent })
              : t("forum.synthesis.created", { count: on.length }),
          ),
      },
    );
  return (
    <section className="forum-ss" id="forum-issues" aria-label={t("forum.synthesis.issues")}>
      <h3>
        {parent ? t("forum.synthesis.subIssues", { number: parent }) : t("forum.synthesis.issues")}
        <span className="forum-grow" />
        <span className="forum-ss__count">
          {pending.length
            ? t("forum.synthesis.marked", { on: on.length, total: pending.length })
            : t("forum.synthesis.allCreated")}
        </span>
      </h3>
      <ul className="forum-iss">
        {list.map(({ issue, created }) => {
          const id = `fi-${topic.id}-${issue.title}`;
          const checked = !created && !off.has(issue.title);
          const ownerOfIssue = issue.owner ?? null;
          const name = ownerOfIssue
            ? ownerOfIssue.type === "agent"
              ? who.agentName(ownerOfIssue.id)
              : who.personName(ownerOfIssue.id)
            : "";
          return (
            <li key={issue.title} data-off={(!created && !checked) || undefined}>
              {created ? (
                <Link
                  to="/org/$orgId/issues/$number"
                  params={{ orgId: org.id, number: String(created.number) }}
                  className="forum-iss__made"
                >
                  <Icon name="check" size={14} />#{created.number}
                </Link>
              ) : (
                <Checkbox
                  id={id}
                  checked={checked}
                  aria-label={issue.title}
                  onCheckedChange={(v) =>
                    setOff((s) => {
                      const next = new Set(s);
                      if (v) next.delete(issue.title);
                      else next.add(issue.title);
                      return next;
                    })
                  }
                />
              )}
              <label htmlFor={created ? undefined : id} className="forum-iss__tx">
                <span>{issue.title}</span>
                <small>
                  {issue.step ? <span>{t("forum.synthesis.step", { n: issue.step })}</span> : null}
                  {ownerOfIssue && name ? (
                    <span className="forum-owner">
                      <ActorAvatar actor={ownerOfIssue} name={name} size="xs" />
                      {created ? t("forum.synthesis.with", { name }) : t("forum.synthesis.goesTo", { name })}
                    </span>
                  ) : (
                    issue.description && <span className="forum-iss__desc">{issue.description}</span>
                  )}
                </small>
              </label>
            </li>
          );
        })}
      </ul>
      {pending.length > 0 && (
        <div className="forum-appr">
          <span className="forum-appr__t">
            <b>
              <Icon name="shield" size={16} />
              {t("forum.synthesis.approveTitle", { name: ownerName, context: who.g(ownerName).context })}
            </b>
            <small>{t(plan && parent ? "forum.synthesis.approveTextPlan" : "forum.synthesis.approveText")}</small>
          </span>
          <Button
            variant="primary"
            size="sm"
            icon="issues"
            disabled={on.length === 0 || action.isPending}
            loading={action.isPending}
            onClick={create}
          >
            {parent
              ? t("forum.synthesis.createSub", { count: on.length, number: parent })
              : t("forum.synthesis.create", { count: on.length })}
          </Button>
        </div>
      )}
    </section>
  );
}

/**
 * The synthesis as a card, decision or plan: who wrote it,
 * what changed in version 2+ (with the previous version a click away), the
 * headline, the format's sections, suggested issues to approve, where it went
 * (the Drive document, back to the origin) and "Salvar na wiki".
 */
export function SynthesisCard({ topic }: { topic: ForumTopicDetail }) {
  const { t } = useTranslation();
  const who = useForumWho();
  const wikiLink = useWikiLinkRenderer();
  const [showPrev, setShowPrev] = useState(false);
  const [savingWiki, setSavingWiki] = useState(false);
  const syn = topic.synthesis;
  if (!syn) return null;
  const s = syn.structured;
  const writer = topic.track.synthesis?.agentId ?? topic.syntheses.at(-1)?.agentId ?? ownerOf(topic);
  const writerName = who.agentName(writer);
  const g = who.g(writerName);
  const plan = syn.format === "plan";
  const agentPosts = topic.posts.filter((p) => p.author.type === "agent" && p.kind === "turn").length;
  const people = topic.posts.some((p) => p.author.type === "person");
  const prev = syn.revision > 1 ? topic.syntheses.find((x) => x.revision === syn.revision - 1) : undefined;
  const current = topic.syntheses.find((x) => x.revision === syn.revision) ?? topic.syntheses.at(-1);
  const closing = topic.posts.filter((p) => p.kind === "synthesis" || p.meta?.synthesis === true).at(-1);
  const markdown = current?.markdown || closing?.body || "";
  const changes = syn.revision > 1 ? (s?.changes.length ? s.changes : (syn.versions.at(-1)?.changes ?? [])) : [];
  const parent = topic.origin.kind === "issue" ? topic.origin.issueNumber : null;
  const created = syn.createdIssues.length;
  return (
    <section
      className="forum-syn"
      id="forum-synthesis"
      aria-label={t(plan ? "forum.synthesis.eyebrowPlan" : "forum.synthesis.eyebrow")}
    >
      <div className="forum-syn__h">
        {writer && <SeatAvatar seat={{ type: "agent", id: writer }} size="md" mode="done" />}
        <div className="forum-syn__t">
          <span className="forum-eyebrow">{t(plan ? "forum.synthesis.eyebrowPlan" : "forum.synthesis.eyebrow")}</span>
          <b>
            {t(
              syn.revision > 1
                ? "forum.synthesis.rewrote"
                : plan
                  ? "forum.synthesis.closedPlan"
                  : "forum.synthesis.closed",
              { name: writerName, context: g.context },
            )}
          </b>
          <small>
            {[
              syn.revision > 1 ? t("forum.synthesis.version", { n: syn.revision }) : null,
              t("forum.rounds", { count: Math.max(1, topic.round) }),
              t(people ? "forum.synthesis.metaPeople" : "forum.synthesis.meta", {
                posts: agentPosts,
                agents: topic.agentIds.length,
              }),
            ]
              .filter(Boolean)
              .join(" · ")}
          </small>
        </div>
      </div>
      {changes.length > 0 && (
        <div className="forum-chg">
          <span className="forum-eyebrow">{t("forum.synthesis.changes", { n: syn.revision })}</span>
          <List items={changes} icon="flag" />
          {prev && (
            <div>
              <button
                type="button"
                className="ac-link forum-vlink"
                aria-expanded={showPrev}
                onClick={() => setShowPrev((x) => !x)}
              >
                {t(showPrev ? "forum.synthesis.hideV" : "forum.synthesis.showV", { n: prev.revision })}
              </button>
            </div>
          )}
          {showPrev && prev && (
            <div className="forum-v1">
              <span className="forum-eyebrow">
                {t("forum.synthesis.versionN", { n: prev.revision })}{" "}
                <span className="forum-v1__sub">
                  {t("forum.synthesis.replaced", { round: syn.versions.at(-1)?.afterRound ?? topic.round })}
                </span>
              </span>
              <b>{t(prev.structured.format === "plan" ? "forum.synthesis.objective" : "forum.synthesis.decision")}</b>
              <span>{headlineOf(prev.structured)}</span>
              {prev.structured.format === "decision" && (
                <>
                  <b>{t("forum.synthesis.nextSteps")}</b>
                  <span>{prev.structured.nextSteps.map((n) => n.text).join(" · ") || t("forum.synthesis.none")}</span>
                </>
              )}
            </div>
          )}
        </div>
      )}
      {s ? (
        <>
          <div className="forum-dec">
            <span className="forum-eyebrow">{t(plan ? "forum.synthesis.objective" : "forum.synthesis.decision")}</span>
            <p className={headlineOf(s).length > 220 ? "forum-dec__long" : undefined}>
              {renderInline(headlineOf(s), "dec")}
            </p>
          </div>
          {s.format === "plan" ? <PlanBody s={s} topic={topic} /> : <DecisionBody s={s} />}
        </>
      ) : (
        markdown && (
          <div className="forum-syn__md">
            <Markdown source={markdown} variant="message" wikiLink={wikiLink} />
          </div>
        )
      )}
      <SuggestedIssues topic={topic} />
      <Section title={t("forum.synthesis.wentTo")}>
        <div className="forum-went">
          {syn.artifactId ? (
            <ArtifactCard artifact={{ id: syn.artifactId, version: syn.version, deleted: syn.deleted }} />
          ) : (
            <span />
          )}
          <div className="forum-went__col">
            <OriginLink topic={topic} className="forum-wrow">
              {parent
                ? created
                  ? t("forum.synthesis.backIssueDone", { number: parent, count: created })
                  : t("forum.synthesis.backIssue", { number: parent })
                : topic.originChannelId || topic.origin.channelId
                  ? t("forum.synthesis.backChannel")
                  : t("forum.synthesis.backNone")}
            </OriginLink>
            {markdown && (
              <button type="button" className="forum-wrow" onClick={() => setSavingWiki(true)}>
                <Icon name="book" size={16} />
                <span>{t("forum.synthesis.saveWiki")}</span>
              </button>
            )}
          </div>
        </div>
      </Section>
      {markdown && (
        <SaveToWikiDialog
          open={savingWiki}
          onClose={() => setSavingWiki(false)}
          text={markdown}
          source={{ kind: "forum", topicId: topic.id }}
          from={t("wiki.fromForum")}
        />
      )}
    </section>
  );
}
