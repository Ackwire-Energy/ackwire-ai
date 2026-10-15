import { type AgentAppearance, Button, Icon } from "@agenteschat/ui";
import { forwardRef, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { WAITLIST_EMAIL } from "./data";
import { useJoy } from "./hooks";
import { LpAvatar } from "./LpAvatar";

export type JoinResult = "ok" | "invalid" | "rate" | "failed";
/** What happened to a confirmation link the page was opened with. */
export type LinkProblem = "expired" | "confirmFailed";

interface WaitlistProps {
  /** The hero form has the privacy note and steers the giant's eyes. */
  variant: "hero" | "final";
  /** The email already on the list (both forms show the done state). */
  joined: string | null;
  /** The email is confirmed: "you're on the list" instead of "check your email". */
  confirmed: boolean;
  /** A confirmation link that didn't work, shown above the hero form. */
  linkProblem?: LinkProblem | null;
  /** The look of the happy agent in the done state (the giant's). */
  look: AgentAppearance;
  onJoin: (email: string) => Promise<JoinResult>;
  onTyping: () => void;
  onFocusInput?: (input: HTMLInputElement | null) => void;
}

/** The only call to action: the waiting list form, or "you're on the list". */
export const Waitlist = forwardRef<HTMLDivElement, WaitlistProps>(function Waitlist(
  { variant, joined, confirmed, linkProblem, onJoin, onTyping, onFocusInput, look },
  ref,
) {
  const { t } = useTranslation();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<JoinResult | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    const value = email.trim();
    setError(null);
    if (!WAITLIST_EMAIL.test(value)) {
      setError("invalid");
      input.current?.focus();
      return;
    }
    setPending(true);
    const result = await onJoin(value);
    setPending(false);
    if (result !== "ok") {
      setError(result);
      if (result === "invalid") input.current?.focus();
    }
  };

  const message =
    !error && variant === "hero" && linkProblem
      ? t(`landing.waitlist.${linkProblem}`)
      : error === "invalid"
        ? t("landing.waitlist.invalid")
        : error === "rate"
          ? t("landing.waitlist.rateLimited")
          : error === "failed"
            ? t("landing.waitlist.failed")
            : null;

  return (
    <div className={variant === "final" ? "lp-slot" : undefined} ref={ref}>
      {joined !== null || confirmed ? (
        <Done email={joined ?? ""} confirmed={confirmed} look={look} />
      ) : (
        <>
          <form
            className="lp-wl"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label htmlFor={id} className="lp-sr">
              {t("landing.waitlist.label")}
            </label>
            <input
              ref={input}
              id={id}
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder={t("landing.waitlist.placeholder")}
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setError(null);
                onTyping();
              }}
              onFocus={(e) => onFocusInput?.(e.currentTarget)}
              onBlur={() => onFocusInput?.(null)}
            />
            <Button type="submit" className="lp-bsky" loading={pending}>
              {t("landing.waitlist.submit")}
            </Button>
          </form>
          {message && (
            <div className="lp-wl-err" role="alert">
              <Icon name="alert" size={16} />
              {message}
            </div>
          )}
          {variant === "hero" && (
            <div className="lp-wl-note">
              <Icon name="lock" size={16} />
              {t("landing.waitlist.note")}
            </div>
          )}
        </>
      )}
    </div>
  );
});

function Done({ email, confirmed, look }: { email: string; confirmed: boolean; look: AgentAppearance }) {
  const { t } = useTranslation();
  const joy = useJoy();
  const { trigger } = joy;
  useEffect(() => trigger(2400), [trigger]);
  return (
    <div className="lp-wl-done" role="status">
      <LpAvatar look={look} className={joy.className} />
      <div>
        <b>{t(confirmed ? "landing.waitlist.doneTitle" : "landing.waitlist.checkTitle")}</b>
        <span>{confirmed ? t("landing.waitlist.doneText") : t("landing.waitlist.checkText", { email })}</span>
      </div>
    </div>
  );
}
