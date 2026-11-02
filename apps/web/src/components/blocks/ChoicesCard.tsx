import { useAnswerChoices, useArtifact, useChoices } from "@agenteschat/client";
import {
  type ChoiceDraft,
  choiceLetter,
  choiceOfKey,
  choiceSummary,
  emptyDraft,
  moveStep,
  pickChoice,
} from "@agenteschat/client/lib/choices";
import { Button, Spinner } from "@agenteschat/ui";
import { type KeyboardEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { CardSky, colorOf } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import "./blocks.css";

/**
 * An agent asks the person to pick (ADR 0124): options as big rows lettered A, B, C…, one question at a time. A click
 * (or its letter, or arrows and Enter) answers at once: it goes to the agent as the person's message, and the card
 * then shows what was picked to everyone. The app's own card, like a vote: a pick is an act of the person's.
 */
export function ChoicesCard({ id, version }: { id: string; version?: number }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const artifact = useArtifact(org.id, id, version);
  const query = useChoices(org.id, id);
  const answer = useAnswerChoices(org.id, id);
  const [draft, setDraft] = useState<ChoiceDraft | null>(null);
  const [closed, setClosed] = useState(false);
  const list = useRef<HTMLFieldSetElement>(null);
  const a = artifact.data;
  if (a?.content.kind !== "choices" || !query.data) {
    return (
      <div className="live-block live-block--loading" aria-busy="true">
        <Spinner />
        <span>{t("blocks.building")}</span>
      </div>
    );
  }
  const { questions } = a.content;
  const answered = query.data.answer;
  const agent = dir.anyAgent(a.createdBy.id);

  if (answered) {
    const by = dir.memberById.get(answered.userId)?.name ?? t("blocks.someone");
    return (
      <section className="live-block choices" aria-label={a.title} data-answered="">
        <CardSky color={colorOf(agent)} />
        <header className="live-block__head">
          <span className="live-block__titles">
            <b>{a.title}</b>
            <small>{t("choices.answeredBy", { name: by })}</small>
          </span>
        </header>
        <ul className="choices__summary">
          {choiceSummary(questions, answered.picks).map((s) => (
            <li key={s.question}>
              {questions.length > 1 && <span className="choices__asked">{s.question}</span>}
              <span className="choices__picked">
                <span className="choices__letter" aria-hidden="true">
                  {s.letter}
                </span>
                {s.label}
              </span>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  if (closed) {
    return (
      <p className="choices__closed">
        <span>{t("choices.closed", { title: a.title })}</span>
        <button type="button" className="ac-link" onClick={() => setClosed(false)}>
          {t("choices.reopen")}
        </button>
      </p>
    );
  }

  const d = draft ?? emptyDraft(questions);
  const q = questions[d.step];
  if (!q) return null;
  const pick = (option: number) => {
    if (answer.isPending) return;
    const next = pickChoice(d, option);
    setDraft(next.draft);
    if (next.send)
      answer.mutate(next.send, {
        onError: () => {
          toast.show(t("choices.failed"), "error");
          void query.refetch();
        },
      });
    else requestAnimationFrame(() => list.current?.querySelector<HTMLButtonElement>("button")?.focus());
  };
  const onKeyDown = (e: KeyboardEvent<HTMLFieldSetElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const letter = choiceOfKey(e.key, q.options.length);
    if (letter !== null) {
      e.preventDefault();
      pick(letter);
      return;
    }
    const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>(".choices__option") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const by = e.key === "ArrowDown" ? 1 : -1;
      rows[(at + by + rows.length) % rows.length]?.focus();
    } else if (questions.length > 1 && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      setDraft(moveStep(d, e.key === "ArrowRight" ? 1 : -1));
    }
  };
  return (
    <section className="live-block choices" aria-label={a.title}>
      <CardSky color={colorOf(agent)} />
      <header className="live-block__head">
        <span className="live-block__titles">
          <b>{a.title}</b>
          {questions.length > 1 && <small>{t("choices.step", { step: d.step + 1, total: questions.length })}</small>}
        </span>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="close"
          aria-label={t("choices.close")}
          title={t("choices.close")}
          onClick={() => setClosed(true)}
        />
      </header>
      <p className="choices__question" id={`choices-${id}-q`}>
        {q.question}
      </p>
      <fieldset
        ref={list}
        className="choices__options"
        aria-labelledby={`choices-${id}-q`}
        aria-keyshortcuts={q.options.map((_, i) => choiceLetter(i)).join(" ")}
        onKeyDown={onKeyDown}
      >
        {q.options.map((o, i) => (
          <button
            key={o.label}
            type="button"
            className="choices__option"
            aria-pressed={d.picks[d.step] === i}
            disabled={answer.isPending}
            onClick={() => pick(i)}
          >
            <span className="choices__letter" aria-hidden="true">
              {choiceLetter(i)}
            </span>
            <span className="choices__text">
              <span className="choices__label">{o.label}</span>
              {o.description && <span className="choices__description">{o.description}</span>}
            </span>
          </button>
        ))}
      </fieldset>
      {questions.length > 1 && (
        <div className="live-block__foot choices__foot">
          <Button size="sm" variant="ghost" disabled={d.step === 0} onClick={() => setDraft(moveStep(d, -1))}>
            {t("choices.back")}
          </Button>
          <span className="choices__dots" aria-hidden="true">
            {questions.map((qq, i) => (
              <span
                key={qq.question}
                className="choices__dot"
                data-on={i === d.step ? "" : undefined}
                data-done={d.picks[i] !== null ? "" : undefined}
              />
            ))}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={d.step === questions.length - 1 || d.picks[d.step] === null}
            onClick={() => setDraft(moveStep(d, 1))}
          >
            {t("choices.next")}
          </Button>
        </div>
      )}
    </section>
  );
}
