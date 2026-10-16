import {
  Avatar,
  AvatarStack,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  type IconName,
  Input,
  SearchInput,
  Segmented,
  Textarea,
} from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useForumAction, useForumTopic } from "@/api/queries";
import type { ForumStatus, ForumSuggestedIssue, ForumTopic, ForumTopicDetail } from "@/api/types";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { canTalk } from "@/lib/audience";
import { formatPercent, joinNames, relativeTime } from "@/lib/format";
import { can } from "@/lib/permissions";
import { parseAmount } from "@/lib/text";
import { useToast } from "@/lib/toast";

const STATUS_ICON: Record<ForumStatus, IconName> = { open: "message", done: "check", canceled: "block" };

/** "Em discussão · rodada 2 de 3" / "Concluído" / "Cancelado", with an icon. */
export function ForumStatusChip({ topic }: { topic: Pick<ForumTopic, "status" | "round" | "rounds"> }) {
  const { t } = useTranslation();
  return (
    <Chip icon={STATUS_ICON[topic.status]}>
      {t(`forum.status.${topic.status}`, { round: Math.max(topic.round, 1), rounds: topic.rounds })}
    </Chip>
  );
}

/** The agents (living symbols) and the people of a topic. */
export function ForumParticipants({ topic, max = 5 }: { topic: ForumTopic; max?: number }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agents = topic.agentIds.map((id) => ({ id, name: dir.agentById.get(id)?.name ?? "" }));
  const people = topic.userIds.map((id) => dir.memberById.get(id)).filter((m) => m !== undefined);
  const names = [...agents.map((a) => a.name), ...people.map((p) => p.name)].filter(Boolean);
  return (
    <AvatarStack role="img" aria-label={t("forum.participants", { names: joinNames(names, t("newAgent.and")) })}>
      {agents.slice(0, max).map((a) => (
        <AgentAvatar key={a.id} agentId={a.id} channelId={topic.channelId} name={a.name} size="sm" />
      ))}
      {people.slice(0, Math.max(0, max - agents.length)).map((p) => (
        <Avatar key={p.userId} size="sm" name={p.name} imageUrl={p.image} />
      ))}
    </AvatarStack>
  );
}

/** "12% do limite": the discussion's spend cap used (never money: everyone reads the forum). Null without a cap. */
export function useForumCost() {
  const { t, i18n } = useTranslation();
  return (topic: ForumTopic) =>
    topic.budgetUsedPercent === null
      ? null
      : t("forum.budgetUsed", { percent: formatPercent(i18n.language, topic.budgetUsedPercent) });
}

/** A topic in the list: title, one line of goal, participants, status, last activity and cost. */
export function ForumTopicCard({ topic }: { topic: ForumTopic }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const cost = useForumCost();
  return (
    <article className="forum-card ac-card ac-card--interactive" aria-labelledby={`ft-${topic.id}`}>
      <div className="forum-card__head">
        <Link
          id={`ft-${topic.id}`}
          className="forum-card__title"
          to="/org/$orgId/forum/$topicId"
          params={{ orgId: org.id, topicId: topic.id }}
        >
          {topic.title}
        </Link>
        <ForumStatusChip topic={topic} />
      </div>
      <p className="forum-card__goal">{topic.goal}</p>
      <div className="forum-card__foot">
        <ForumParticipants topic={topic} />
        <span className="small muted">
          {t("forum.lastActivity", { when: relativeTime(t, i18n.language, topic.lastActivityAt) })}
        </span>
        <span className="small muted tabular">{cost(topic)}</span>
      </div>
    </article>
  );
}

const ROUND_OPTIONS = ["1", "2", "3", "5"] as const;

/** "Novo tópico": title, the question, agents (only those that answer me), people to notify, rounds, cap. */
export function NewTopicDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const navigate = useNavigate();
  const action = useForumAction(org.id);
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [userIds, setUserIds] = useState<string[]>([]);
  const [rounds, setRounds] = useState<(typeof ROUND_OPTIONS)[number]>("3");
  const [budget, setBudget] = useState("");
  const [q, setQ] = useState("");
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setGoal("");
    setAgentIds([]);
    setUserIds([]);
    setRounds("3");
    setBudget("");
    setQ("");
    setTouched(false);
  }, [open]);
  const query = q.trim().toLowerCase();
  const agents = dir.agents.filter((a) => !query || `${a.name} ${a.handle} ${a.role}`.toLowerCase().includes(query));
  const people = dir.members.filter((m) => m.userId !== me.user.id);
  const seesCost = can(org.role, "view_usage");
  const budgetValue = budget.trim() ? parseAmount(budget) : null;
  const budgetError = budgetValue !== null && !(budgetValue > 0) ? t("forum.form.budgetInvalid") : undefined;
  const valid = title.trim() && goal.trim() && agentIds.length > 0 && !budgetError;
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...list, id] : list.filter((x) => x !== id));
  const submit = () => {
    setTouched(true);
    if (!valid) return;
    action.mutate(
      {
        type: "create",
        input: {
          title: title.trim(),
          goal: goal.trim(),
          agentIds,
          userIds,
          rounds: Number(rounds),
          ...(seesCost ? { budgetUsd: budgetValue } : {}),
        },
      },
      {
        onSuccess: (topic) => {
          toast.show(t("forum.form.created"));
          onClose();
          void navigate({
            to: "/org/$orgId/forum/$topicId",
            params: { orgId: org.id, topicId: (topic as ForumTopicDetail).id },
          });
        },
      },
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("forum.new")}
      description={t("forum.subtitle")}
      closeLabel={t("common.close")}
      width={620}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <DialogBody>
          <Field label={t("forum.form.title")} id="ft-title">
            <Input
              value={title}
              placeholder={t("forum.form.titlePlaceholder")}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field label={t("forum.form.goal")} id="ft-goal">
            <Textarea
              rows={3}
              value={goal}
              placeholder={t("forum.form.goalPlaceholder")}
              onChange={(e) => setGoal(e.target.value)}
            />
          </Field>
          <div className="people-picker">
            <span className="ac-field__label">{t("forum.form.agents")}</span>
            <SearchInput
              aria-label={t("forum.form.searchAgents")}
              placeholder={t("forum.form.searchAgents")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {/* biome-ignore lint/a11y/useSemanticElements: a scroll region, not a fieldset */}
            <div className="people-picker__results" role="region" aria-label={t("forum.form.agents")}>
              {agents.map((a) => {
                const talk = canTalk(a);
                const id = `ft-agent-${a.id}`;
                return (
                  <label key={a.id} htmlFor={id} className="scope-row" data-disabled={!talk || undefined}>
                    {/* Named exactly by the agent; the role or "não responde a você" describes it. */}
                    <Checkbox
                      id={id}
                      aria-label={a.name}
                      aria-describedby={`${id}-note`}
                      disabled={!talk}
                      checked={agentIds.includes(a.id)}
                      onCheckedChange={(on) => setAgentIds((l) => toggle(l, a.id, on))}
                    />
                    <AgentAvatar agentId={a.id} name={a.name} size="sm" />
                    <span className="scope-row__text" aria-hidden="true">
                      <span>{a.name}</span>
                      <span className="small muted" id={`${id}-note`}>
                        {talk ? a.role || `@${a.handle}` : t("forum.form.noTalk")}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
          {people.length > 0 && (
            <fieldset className="forum-people">
              <legend className="ac-field__label">{t("forum.form.people")}</legend>
              {people.map((m) => {
                const id = `ft-person-${m.userId}`;
                return (
                  <label key={m.userId} htmlFor={id} className="scope-row">
                    <Checkbox
                      id={id}
                      checked={userIds.includes(m.userId)}
                      onCheckedChange={(on) => setUserIds((l) => toggle(l, m.userId, on))}
                    />
                    <Avatar size="sm" name={m.name} imageUrl={m.image} />
                    <span className="scope-row__text">
                      <span>{m.name}</span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          )}
          <div className="grid-fields">
            <div className="stack-4" style={{ gap: 6 }}>
              <span className="ac-field__label" id="ft-rounds">
                {t("forum.form.rounds")}
              </span>
              <Segmented
                label={t("forum.form.rounds")}
                value={rounds}
                onValueChange={setRounds}
                options={ROUND_OPTIONS.map((r) => ({ value: r, label: r }))}
              />
            </div>
            {/* A spend cap is money: admins only (members' discussions get the default cap). */}
            {seesCost && (
              <Field
                label={t("forum.form.budget")}
                id="ft-budget"
                help={t("forum.form.budgetHelp")}
                error={budgetError}
              >
                <Input
                  inputMode="decimal"
                  placeholder="US$"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                />
              </Field>
            )}
          </div>
          {touched && !valid && !budgetError && <p className="small muted">{t("forum.form.required")}</p>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={action.isPending} loading={action.isPending}>
            {t("forum.form.create")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** Add or remove agents and people of an open topic (`PUT …/participants` with the difference). */
export function ParticipantsDialog({
  topic,
  open,
  onClose,
}: {
  topic: ForumTopic;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const action = useForumAction(org.id);
  const [agentIds, setAgentIds] = useState<string[]>(topic.agentIds);
  const [userIds, setUserIds] = useState<string[]>(topic.userIds);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset to the topic each time it opens
  useEffect(() => {
    if (open) {
      setAgentIds(topic.agentIds);
      setUserIds(topic.userIds);
    }
  }, [open]);
  const diff = (now: string[], before: string[]) => ({
    add: now.filter((x) => !before.includes(x)),
    remove: before.filter((x) => !now.includes(x)),
  });
  const a = diff(agentIds, topic.agentIds);
  const u = diff(userIds, topic.userIds);
  const changed = a.add.length + a.remove.length + u.add.length + u.remove.length > 0;
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...list, id] : list.filter((x) => x !== id));
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("forum.editParticipants")}
      closeLabel={t("common.close")}
      width={520}
    >
      <DialogBody>
        <span className="ac-field__label">{t("forum.form.agents")}</span>
        {dir.agents.map((ag) => {
          const id = `fp-agent-${ag.id}`;
          const talk = canTalk(ag) || topic.agentIds.includes(ag.id);
          return (
            <label key={ag.id} htmlFor={id} className="scope-row" data-disabled={!talk || undefined}>
              <Checkbox
                id={id}
                aria-label={ag.name}
                disabled={!talk || (agentIds.length === 1 && agentIds.includes(ag.id))}
                checked={agentIds.includes(ag.id)}
                onCheckedChange={(on) => setAgentIds((l) => toggle(l, ag.id, on))}
              />
              <AgentAvatar agentId={ag.id} name={ag.name} size="sm" />
              <span className="scope-row__text" aria-hidden="true">
                <span>{ag.name}</span>
              </span>
            </label>
          );
        })}
        <span className="ac-field__label">{t("forum.form.people")}</span>
        {dir.members
          .filter((m) => m.userId !== me.user.id)
          .map((m) => {
            const id = `fp-person-${m.userId}`;
            return (
              <label key={m.userId} htmlFor={id} className="scope-row">
                <Checkbox
                  id={id}
                  aria-label={m.name}
                  checked={userIds.includes(m.userId)}
                  onCheckedChange={(on) => setUserIds((l) => toggle(l, m.userId, on))}
                />
                <Avatar size="sm" name={m.name} imageUrl={m.image} />
                <span className="scope-row__text" aria-hidden="true">
                  <span>{m.name}</span>
                </span>
              </label>
            );
          })}
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          disabled={!changed || action.isPending}
          loading={action.isPending}
          onClick={() =>
            action.mutate(
              {
                type: "participants",
                topicId: topic.id,
                input: { addAgentIds: a.add, removeAgentIds: a.remove, addUserIds: u.add, removeUserIds: u.remove },
              },
              {
                onSuccess: () => {
                  toast.show(t("forum.participantsSaved"));
                  onClose();
                },
              },
            )
          }
        >
          {t("common.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** "Criar issues sugeridas": the synthesis' suggestions with checkboxes (all on). */
export function CreateIssuesDialog({
  topicId,
  items,
  open,
  onClose,
}: {
  topicId: string;
  items: ForumSuggestedIssue[];
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const action = useForumAction(org.id);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (open) setPicked(new Set(items.map((_, i) => i)));
  }, [open, items]);
  const chosen = items.filter((_, i) => picked.has(i));
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("forum.issuesTitle")}
      description={t("forum.issuesText")}
      closeLabel={t("common.close")}
      width={560}
    >
      <DialogBody>
        {items.map((it, i) => {
          const id = `fi-${i}`;
          return (
            <label key={it.title} htmlFor={id} className="scope-row">
              <Checkbox
                id={id}
                checked={picked.has(i)}
                onCheckedChange={(on) =>
                  setPicked((s) => {
                    const next = new Set(s);
                    if (on) next.add(i);
                    else next.delete(i);
                    return next;
                  })
                }
              />
              <span className="scope-row__text">
                <span style={{ fontWeight: 600 }}>{it.title}</span>
                <span className="small muted">{it.description}</span>
              </span>
            </label>
          );
        })}
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          disabled={chosen.length === 0 || action.isPending}
          loading={action.isPending}
          onClick={() =>
            action.mutate(
              { type: "issues", topicId, items: chosen },
              {
                onSuccess: () => {
                  toast.show(t("forum.issuesCreated", { count: chosen.length }));
                  onClose();
                },
              },
            )
          }
        >
          {t("forum.issuesCreate", { count: chosen.length })}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** The topic a chat message points at (`meta.forumTopic` / `meta.forumTopicId`), or null. */
export function forumTopicOfMessage(meta: Record<string, unknown> | undefined): string | null {
  const t = meta?.forumTopic as { id?: unknown } | undefined;
  if (t && typeof t.id === "string") return t.id;
  return typeof meta?.forumTopicId === "string" ? meta.forumTopicId : null;
}

/** In a channel: the topic an agent opened, with "Ver discussão". */
export function ForumMessageCard({ topicId }: { topicId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const topic = useForumTopic(org.id, topicId);
  const cost = useForumCost();
  if (!topic.data) return null;
  const tp = topic.data;
  return (
    <section className="forum-msg-card ac-card" aria-label={t("forum.card")}>
      <div className="forum-card__head">
        <span className="forum-card__title">{tp.title}</span>
        <ForumStatusChip topic={tp} />
      </div>
      <p className="forum-card__goal">{tp.goal}</p>
      <div className="forum-card__foot">
        <ForumParticipants topic={tp} />
        <span className="small muted tabular">{cost(tp)}</span>
        <span style={{ flex: 1 }} />
        <Button asChild size="sm">
          <Link to="/org/$orgId/forum/$topicId" params={{ orgId: org.id, topicId: tp.id }}>
            {t("forum.see")}
          </Link>
        </Button>
      </div>
    </section>
  );
}
