import type { ForumFormat, ForumSeat, ForumTopicDetail, ForumTopicInput } from "@agenteschat/client";
import { useForumAction } from "@agenteschat/client";
import { canTalk } from "@agenteschat/client/lib/audience";
import {
  addAgentSeat,
  type DeadlineChoice,
  deadlineChoices,
  MAX_AGENTS,
  MIN_AGENTS,
  moveSeat,
  ROUND_CHOICES,
  seatKey,
  tableInput,
  toggleSeat,
} from "@agenteschat/client/lib/forum";
import {
  Avatar,
  Button,
  CountChip,
  Dialog,
  DialogBody,
  DialogFooter,
  Icon,
  type IconName,
  Input,
  Segmented,
  Switch,
  Textarea,
} from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { type DragEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { useForumWho } from "./pieces";
import "@/pages/forum.css";

/** The four starting points of "Novo tópico": format, rounds and the goal's wording. */
export const TEMPLATES: {
  key: "tech" | "review" | "brain" | "postmortem";
  icon: IconName;
  rounds: number;
  format: ForumFormat;
}[] = [
  { key: "tech", icon: "flag", rounds: 3, format: "decision" },
  { key: "review", icon: "document", rounds: 2, format: "plan" },
  { key: "brain", icon: "bulb", rounds: 2, format: "decision" },
  { key: "postmortem", icon: "alert", rounds: 3, format: "plan" },
];

/** What the dialog starts with: a template, an issue ("Avaliar no fórum"), an agent's suggestion ("Editar"). */
export interface NewTopicPreset {
  title?: string;
  goal?: string;
  agentIds?: string[];
  rounds?: number;
  format?: ForumFormat;
  userIds?: string[];
  seatedUserIds?: string[];
  /** The line "Origem: Issue #142 · pedido da Marina · o resultado volta para lá". */
  originText?: string;
  originIssueId?: string;
  heading?: "new" | "fromIssue" | "editSuggestion";
}

/**
 * "Novo tópico": templates first (unless preset), then the question, what
 * comes out (decision or plan), the goal, the table in speaking order
 * (agents and seated people, drag or arrows), people to notify (me always),
 * who sits at the table, rounds and deadline. At least two agents: with one,
 * a thread or "Pedir a" fits better. No money here.
 */
export function NewTopicDialog({
  open,
  onClose,
  preset,
  onSubmit,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  preset?: NewTopicPreset;
  /** Instead of creating (an agent's suggestion: accept with the changes). */
  onSubmit?: (input: ForumTopicInput) => void;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const who = useForumWho();
  const toast = useToast();
  const navigate = useNavigate();
  const action = useForumAction(org.id);
  const [step, setStep] = useState<"templates" | "form">("templates");
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [format, setFormat] = useState<ForumFormat>("decision");
  const [order, setOrder] = useState<ForumSeat[]>([]);
  const [people, setPeople] = useState<string[]>([]);
  const [rounds, setRounds] = useState(3);
  const [deadline, setDeadline] = useState<DeadlineChoice>("none");
  const [heading, setHeading] = useState<string>(t("forum.form.title"));
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [now] = useState(() => new Date());
  const deadlines = deadlineChoices(now);

  const fill = (p: NewTopicPreset | undefined, templateTitle?: string) => {
    setTitle(p?.title ?? "");
    setGoal(p?.goal ?? "");
    setFormat(p?.format ?? "decision");
    setRounds(p?.rounds ?? 3);
    setDeadline("none");
    const agents = (p?.agentIds ?? []).map((id) => ({ type: "agent" as const, id }));
    const seated = (p?.seatedUserIds ?? []).map((id) => ({ type: "person" as const, id }));
    setOrder([...agents, ...seated]);
    setPeople((p?.userIds ?? []).filter((id) => id !== who.me));
    setHeading(
      templateTitle ??
        (p?.heading === "fromIssue"
          ? t("forum.form.fromIssue")
          : p?.heading === "editSuggestion"
            ? t("forum.form.editSuggestion")
            : t("forum.form.title")),
    );
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: start over each time it opens
  useEffect(() => {
    if (!open) return;
    fill(preset);
    setStep(preset ? "form" : "templates");
  }, [open]);

  const agentIds = order.filter((s) => s.type === "agent").map((s) => s.id);
  const owner = agentIds[0];
  const rest = who.dir.agents.filter((a) => !agentIds.includes(a.id));
  const others = who.dir.members.filter((m) => m.userId !== who.me);
  const valid = title.trim() !== "" && goal.trim() !== "" && agentIds.length >= MIN_AGENTS;
  const pending = busy ?? action.isPending;

  const submit = () => {
    if (!valid) return;
    const at = deadlines.find((d) => d.key === deadline)?.at ?? null;
    const input: ForumTopicInput = {
      title: title.trim(),
      goal: goal.trim(),
      ...tableInput(order),
      userIds: people,
      rounds,
      format,
      ...(at ? { deadline: at.toISOString() } : {}),
      ...(preset?.originIssueId ? { originIssueId: preset.originIssueId } : {}),
    };
    if (onSubmit) return onSubmit(input);
    action.mutate(
      { type: "create", input },
      {
        onSuccess: (topic) => {
          toast.show(t("forum.form.created", { name: who.agentName(owner) }));
          onClose();
          void navigate({
            to: "/org/$orgId/forum/$topicId",
            params: { orgId: org.id, topicId: (topic as ForumTopicDetail).id },
          });
        },
      },
    );
  };

  const onDrop = (to: number) => (e: DragEvent) => {
    e.preventDefault();
    if (drag !== null) setOrder((o) => moveSeat(o, drag, to));
    setDrag(null);
    setOver(null);
  };
  const seatName = (s: ForumSeat) =>
    s.type === "person" && s.id === who.me ? t("forum.you", { name: who.personName(s.id) }) : who.seatName(s);

  if (step === "templates")
    return (
      <Dialog
        open={open}
        onOpenChange={(o) => !o && onClose()}
        title={t("forum.form.title")}
        description={t("forum.form.templatesText")}
        closeLabel={t("common.close")}
        width={640}
      >
        <DialogBody>
          <div className="forum-tpls">
            {TEMPLATES.map((x) => (
              <button
                key={x.key}
                type="button"
                className="forum-tpl"
                onClick={() => {
                  fill(
                    { goal: t(`forum.form.templates.${x.key}.goal`), rounds: x.rounds, format: x.format },
                    t(`forum.form.templates.${x.key}.title`),
                  );
                  setStep("form");
                }}
              >
                <span className="forum-tpl__icon">
                  <Icon name={x.icon} size={18} />
                </span>
                <span>
                  <b>{t(`forum.form.templates.${x.key}.title`)}</b>
                  <small>{t(`forum.form.templates.${x.key}.text`)}</small>
                  <em>
                    {t("forum.form.templateMeta", {
                      rounds: t("forum.rounds", { count: x.rounds }),
                      format: t(`forum.format.${x.format}`).toLowerCase(),
                    })}
                  </em>
                </span>
              </button>
            ))}
            <button
              type="button"
              className="forum-tpl forum-tpl--blank"
              onClick={() => {
                fill(undefined);
                setStep("form");
              }}
            >
              <span className="forum-tpl__icon">
                <Icon name="plus" size={18} />
              </span>
              <span>
                <b>{t("forum.form.templates.blank.title")}</b>
                <small>{t("forum.form.templates.blank.text")}</small>
              </span>
            </button>
          </div>
        </DialogBody>
        <DialogFooter note={t("forum.form.tip")} />
      </Dialog>
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={heading}
      description={t("forum.form.subtitle")}
      closeLabel={t("common.close")}
      width={640}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <DialogBody className="forum-form">
          <div className="forum-fld">
            <label htmlFor="ft-title">{t("forum.form.question")}</label>
            <Input
              id="ft-title"
              value={title}
              autoComplete="off"
              placeholder={t("forum.form.questionPlaceholder")}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          {preset?.originText && (
            <p className="forum-oline ac-iconline">
              <Icon name="issues" size={16} />
              <span>{t("forum.form.origin", { origin: preset.originText })}</span>
            </p>
          )}
          <div className="forum-fld">
            <span className="forum-fld__label" id="ft-format">
              {t("forum.form.format")}
            </span>
            <Segmented
              label={t("forum.form.format")}
              value={format}
              onValueChange={setFormat}
              options={(["decision", "plan"] as const).map((f) => ({
                value: f,
                label: (
                  <>
                    <Icon name={f === "plan" ? "document" : "flag"} size={16} />
                    {t(`forum.format.${f}`)}
                  </>
                ),
              }))}
            />
            <span className="forum-fld__hint">{t(`forum.format.${format}Hint`)}</span>
          </div>
          <div className="forum-fld">
            <label htmlFor="ft-goal">{t("forum.form.goal")}</label>
            <Textarea
              id="ft-goal"
              rows={2}
              value={goal}
              placeholder={t("forum.form.goalPlaceholder")}
              onChange={(e) => setGoal(e.target.value)}
            />
          </div>
          <div className="forum-fld">
            <span className="forum-fld__label">
              {t("forum.form.table")} <span className="forum-fld__hint">{t("forum.form.tableHint")}</span>
            </span>
            {order.length > 0 && (
              <ol className="forum-order" aria-label={t("forum.form.table")}>
                {order.map((s, i) => {
                  const name = seatName(s);
                  const person = s.type === "person";
                  const a = person ? undefined : who.dir.agentById.get(s.id);
                  return (
                    <li
                      key={seatKey(s)}
                      draggable
                      className={[drag === i && "is-dragging", over === i && "is-over"].filter(Boolean).join(" ")}
                      onDragStart={(e) => {
                        setDrag(i);
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", String(i));
                      }}
                      onDragEnd={() => {
                        setDrag(null);
                        setOver(null);
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setOver(i);
                      }}
                      onDragLeave={() => setOver((o) => (o === i ? null : o))}
                      onDrop={onDrop(i)}
                    >
                      <span className="forum-order__grip" aria-hidden="true">
                        <Icon name="grip" size={16} />
                      </span>
                      <CountChip>{i + 1}</CountChip>
                      {person ? (
                        <Avatar
                          kind="person"
                          size="sm"
                          name={who.personName(s.id)}
                          imageUrl={who.dir.memberById.get(s.id)?.image}
                        />
                      ) : (
                        <AgentAvatar agentId={s.id} name={name} size="sm" state="idle" />
                      )}
                      <span className="forum-order__t">
                        <b>{name}</b>
                        <small>
                          {person
                            ? t("forum.form.personSeat")
                            : [
                                a?.role,
                                s.id === owner
                                  ? t(format === "plan" ? "forum.table.writesPlan" : "forum.table.writes")
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                        </small>
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        iconOnly
                        icon="chevronUp"
                        aria-label={t("forum.form.up", { name })}
                        disabled={i === 0}
                        onClick={() => setOrder((o) => moveSeat(o, i, i - 1))}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        iconOnly
                        icon="chevronDown"
                        aria-label={t("forum.form.down", { name })}
                        disabled={i === order.length - 1}
                        onClick={() => setOrder((o) => moveSeat(o, i, i + 1))}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        iconOnly
                        icon="close"
                        aria-label={t(person ? "forum.form.unseat" : "forum.form.remove", { name })}
                        onClick={() => setOrder((o) => o.filter((x) => seatKey(x) !== seatKey(s)))}
                      />
                    </li>
                  );
                })}
              </ol>
            )}
            {rest.length > 0 && (
              // biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons
              <div className="forum-pickrow" role="group" aria-label={t("forum.form.addAgents")}>
                {rest.map((a) => {
                  const talk = canTalk(a);
                  const full = agentIds.length >= MAX_AGENTS;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      disabled={!talk || full}
                      title={talk ? undefined : t("forum.form.noTalkTitle", { name: a.name })}
                      aria-label={t("forum.form.add", { name: a.name })}
                      onClick={() => setOrder((o) => addAgentSeat(o, a.id))}
                    >
                      <AgentAvatar
                        agentId={a.id}
                        name={a.name}
                        size="sm"
                        state="idle"
                        expression={talk ? undefined : "closed"}
                      />
                      {a.name}
                      <small>{talk ? a.role || `@${a.handle}` : t("forum.form.noTalk")}</small>
                    </button>
                  );
                })}
              </div>
            )}
            {agentIds.length === 1 && (
              <span className="forum-fld__hint">{t("forum.form.oneAgent", { name: who.agentName(agentIds[0]) })}</span>
            )}
            {agentIds.length === 0 && <span className="forum-fld__hint">{t("forum.form.minAgents")}</span>}
          </div>
          <div className="forum-fld">
            <span className="forum-fld__label">
              {t("forum.form.people")} <span className="forum-fld__hint">{t("forum.form.peopleHint")}</span>
            </span>
            {/* biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons */}
            <div className="forum-pickrow" role="group" aria-label={t("forum.form.people")}>
              <span className="forum-pickrow__me">
                <Avatar
                  kind="person"
                  size="sm"
                  name={who.personName(who.me)}
                  imageUrl={who.dir.memberById.get(who.me)?.image}
                />
                {who.personName(who.me)}
                <small>{t("forum.form.meAlways")}</small>
              </span>
              {others.map((m) => {
                const on = people.includes(m.userId);
                return (
                  <button
                    key={m.userId}
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      setPeople((p) => (on ? p.filter((x) => x !== m.userId) : [...p, m.userId]));
                      if (on) setOrder((o) => o.filter((s) => !(s.type === "person" && s.id === m.userId)));
                    }}
                  >
                    <Avatar kind="person" size="sm" name={m.name} imageUrl={m.image} />
                    {m.name}
                    {on && <Icon name="check" size={14} className="forum-pickrow__check" />}
                  </button>
                );
              })}
            </div>
            <div className="forum-seatrow">
              {[who.me, ...people].map((id) => {
                const seated = order.some((s) => s.type === "person" && s.id === id);
                const me = id === who.me;
                const name = who.personName(id);
                return (
                  <label key={id} className="forum-toggle" htmlFor={`ft-seat-${id}`}>
                    <Switch
                      id={`ft-seat-${id}`}
                      checked={seated}
                      onCheckedChange={() => setOrder((o) => toggleSeat(o, id))}
                    />
                    <span>
                      {me ? t("forum.form.seatMe") : t("forum.form.seatOther", { name })}{" "}
                      <span className="forum-fld__hint">
                        {t(me ? "forum.form.seatMeHint" : "forum.form.seatOtherHint")}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
          <div className="forum-form__grid">
            <div className="forum-fld">
              <span className="forum-fld__label">{t("forum.form.rounds")}</span>
              <Segmented
                label={t("forum.form.rounds")}
                value={String(rounds)}
                onValueChange={(v) => setRounds(Number(v))}
                options={ROUND_CHOICES.map((n) => ({ value: String(n), label: String(n) }))}
              />
            </div>
            <div className="forum-fld">
              <span className="forum-fld__label">{t("forum.form.deadline")}</span>
              <Segmented
                label={t("forum.form.deadline")}
                value={deadline}
                onValueChange={setDeadline}
                options={deadlines.map((d) => ({ value: d.key, label: t(`forum.form.deadlines.${d.key}`) }))}
              />
            </div>
          </div>
        </DialogBody>
        <DialogFooter
          note={
            <span className="forum-guard">
              <Icon name="shield" size={14} />
              {t("forum.form.approvals")}
            </span>
          }
        >
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!valid || pending} loading={pending}>
            {preset?.heading === "editSuggestion" || preset?.heading === "fromIssue"
              ? t("forum.form.open")
              : t("forum.form.create")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
