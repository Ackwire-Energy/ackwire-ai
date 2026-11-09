import { useApi, useAuthConfig } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import {
  Button,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  type Expression,
  Icon,
  modKey,
  SettingNote,
  Textarea,
} from "@agenteschat/ui";
import { useMutation } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { TeamScene } from "./TeamScene";
import "./arrival.css";

/** As the server takes it (`FEEDBACK_MAX`). */
const MAX = 4000;
/** How long the agent keeps taking notes after the last key, and its stars after the form is sent. */
const NOTING_MS = 900;
const STARS_MS = 1600;

const ENVELOPE = [
  "###########",
  "##.......##",
  "#.#.....#.#",
  "#..#...#..#",
  "#...#.#...#",
  "#....#....#",
  "#.........#",
  "###########",
];

/** A pixel envelope, drawn in ink on white whatever the theme: it stands on the sky. */
function Envelope({ sent }: { sent: boolean }) {
  return (
    <svg
      className="arrival-envelope"
      data-sent={sent ? "" : undefined}
      viewBox="0 0 11 8"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {ENVELOPE.flatMap((row, y) =>
        [...row].map((cell, x) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed grid
          <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={cell === "#" ? "#151514" : "#fff"} />
        )),
      )}
    </svg>
  );
}

/**
 * The feedback form (ADR 0160): what the person writes goes by email to whoever runs this server. The right hand
 * stands on the sky with an envelope: it takes notes while the person types, and the envelope flies once it is sent.
 * It only illustrates: no agent reads or sends anything.
 */
export function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const toast = useToast();
  const dir = useDirectory(org.id);
  const cloud = useAuthConfig().data?.cloud === true;
  const where = useRouterState({ select: (s) => s.location.pathname });
  const lead = rightHandOf(dir.agents) ?? dir.agents[0];
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const [noting, setNoting] = useState(false);
  const [face, setFace] = useState<Expression>();
  // One id per message: sent again after a failure, the server sends it once.
  const id = useRef(crypto.randomUUID());
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!noting) return;
    const timer = setTimeout(() => setNoting(false), NOTING_MS);
    return () => clearTimeout(timer);
  }, [noting]);
  useEffect(() => {
    if (!sent) return;
    setFace("star");
    const timer = setTimeout(() => setFace("happy"), STARS_MS);
    return () => clearTimeout(timer);
  }, [sent]);
  const send = useMutation({
    meta: { silent: true },
    mutationFn: () => api.system.sendFeedback({ id: id.current, text: text.trim(), orgId: org.id, where, app: "web" }),
    onError: (error) => toast.show(errorText(t, error), "error"),
    onSuccess: () => {
      id.current = crypto.randomUUID();
      setSent(true);
    },
  });
  const ready = text.trim() !== "" && !send.isPending;
  const title = sent ? t("feedback.thanks") : t("feedback.ask");
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={title}
      closeLabel={t("common.close")}
      width={460}
      bare
      initialFocus={box}
      // What was typed stays until it is sent or given up with a button.
      unsaved={!sent && text.trim() !== ""}
      className="arrival arrival-feedback"
    >
      <div className="arrival-hero">
        <TeamScene
          agents={lead ? [lead] : []}
          lead={lead?.id}
          writing={noting && !sent}
          expression={sent ? face : undefined}
        >
          <Envelope sent={sent} />
        </TeamScene>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="close"
          className="arrival-hero__close"
          aria-label={t("common.close")}
          onClick={onClose}
        />
      </div>
      <div className="arrival-lede" aria-live="polite">
        <p className="arrival-lede__title" aria-hidden="true">
          {title}
        </p>
        <p className="arrival-lede__text">
          {sent
            ? t("feedback.reply", { email: me.user.email })
            : t(cloud ? "feedback.goesCloud" : "feedback.goesServer")}
        </p>
      </div>
      {sent ? (
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              setText("");
              setSent(false);
            }}
          >
            {t("feedback.another")}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) send.mutate();
          }}
        >
          <DialogBody>
            <Textarea
              ref={box}
              className="arrival-feedback__text"
              rows={5}
              maxLength={MAX}
              value={text}
              aria-label={t("feedback.ask")}
              placeholder={t("feedback.placeholder")}
              onChange={(e) => {
                setText(e.target.value);
                setNoting(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && ready) {
                  e.preventDefault();
                  send.mutate();
                }
              }}
            />
            <SettingNote icon="mail">{t("feedback.goesWith", { email: me.user.email })}</SettingNote>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              variant="primary"
              icon="send"
              kbd={[modKey(), "↵"]}
              disabled={!ready}
              loading={send.isPending}
            >
              {t("feedback.send")}
            </Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}

/**
 * The way to the feedback form: a quiet row at the bottom of the sidebar, marked Beta. Only where the server takes
 * feedback (`FEEDBACK_EMAIL`): elsewhere there is no row.
 */
export function FeedbackMark() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (useAuthConfig().data?.feedback !== true) return null;
  return (
    <div className="sidebar__feedback">
      <button type="button" className="sidebar__item" aria-label={t("feedback.open")} onClick={() => setOpen(true)}>
        <Icon name="message" />
        <span className="sidebar__item-label">{t("feedback.open")}</span>
        <Chip>{t("feedback.mark")}</Chip>
      </button>
      {open && <FeedbackDialog onClose={() => setOpen(false)} />}
    </div>
  );
}
