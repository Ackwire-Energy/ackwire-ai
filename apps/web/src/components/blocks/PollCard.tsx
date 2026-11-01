import type { Poll } from "@agenteschat/client";
import { useArtifact, usePoll, useVote } from "@agenteschat/client";
import { pollAnswered, pollIsOpen, pollTally, pollToggle } from "@agenteschat/client/lib/blocks";
import { Icon, Spinner } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { CardSky, colorOf } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import "./blocks.css";

const FACES = 5;

/**
 * A vote in the conversation (ADR 0109). The app's own card, never a page: a vote is an act of the person's, and a
 * page in a frame could cast one the moment it showed. Everyone sees the marks arrive (`poll.updated`).
 */
export function PollCard({ id, version }: { id: string; version?: number }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const artifact = useArtifact(org.id, id, version);
  const query = usePoll(org.id, id);
  const vote = useVote(org.id, id);
  const a = artifact.data;
  const poll: Poll | undefined = query.data;
  if (!a || a.content.kind !== "poll" || !poll) {
    return (
      <div className="live-block live-block--loading" aria-busy="true">
        <Spinner />
        <span>{t("blocks.building")}</span>
      </div>
    );
  }
  const { options, multiple, question } = a.content;
  const open = pollIsOpen(poll);
  const answered = pollAnswered(poll);
  const tally = pollTally(options, poll);
  const top = Math.max(...tally.map((o) => o.voters.length));
  const nameOf = (userId: string) => dir.memberById.get(userId)?.name ?? t("blocks.someone");
  const closes = new Date(poll.closesAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
  return (
    <section className="live-block" aria-label={question}>
      <CardSky color={colorOf(dir.anyAgent(a.createdBy.id))} />
      <header className="live-block__head">
        <span className="live-block__titles">
          <b>{question}</b>
          <small>{open ? t("blocks.pollCloses", { time: closes }) : t("blocks.pollClosed")}</small>
        </span>
      </header>
      <div className="poll__options">
        {tally.map((o) => {
          const mine = o.voters.includes(me.user.id);
          const won = !open && top > 0 && o.voters.length === top;
          return (
            <button
              key={o.option}
              type="button"
              className="poll__option"
              aria-pressed={mine}
              data-won={won ? "" : undefined}
              disabled={!open || vote.isPending}
              onClick={() =>
                vote.mutate(pollToggle(poll, me.user.id, o.option, multiple), {
                  onError: () => toast.show(t("blocks.voteFailed"), "error"),
                })
              }
            >
              <span className="poll__fill" style={{ width: `${o.share * 100}%` }} />
              <span className="poll__box">{mine && <Icon name="check" size={14} />}</span>
              <span className="poll__label">{o.label}</span>
              <span className="poll__faces" aria-label={o.voters.map(nameOf).join(", ")}>
                {o.voters.slice(0, FACES).map((v) => (
                  <span key={v} className="poll__face" title={nameOf(v)} aria-hidden="true">
                    {nameOf(v).slice(0, 1).toUpperCase()}
                  </span>
                ))}
                {o.voters.length > FACES && <span className="poll__face">+{o.voters.length - FACES}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {multiple && open && <p className="poll__note">{t("blocks.pollMultiple")}</p>}
      <div className="live-block__foot">
        <span className="live-block__sent">
          <span className="live-block__mark" data-open={open ? "" : undefined} aria-hidden="true" />
          {t("blocks.pollAnswered", { count: answered, total: poll.people })}
        </span>
      </div>
    </section>
  );
}
