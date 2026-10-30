import type { AccountLoginStart, AccountLoginStatus, MachineAccount, MachineAccountKind } from "@agenteschat/client";
import { keys, useAccountLogin, useApi } from "@agenteschat/client";
import { beginLogin, freeDuplicate, isSignInCode } from "@agenteschat/client/lib/machines";
import { type PlanId, planKeyFits, planOf } from "@agenteschat/client/lib/plans";
import { accountCodeAad, sealSecret } from "@agenteschat/client/lib/secret-box";
import { Button, cx, Icon, InfoHint, Input, ProviderLogo, SettingNote } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { openPopup, sendPopup } from "@/lib/popup";

/*
 * "Adicionar conta" (ADR 0041 §2, ADR 0059): the computer starts the
 * provider's own sign-in and its link opens here, in a window of its own: the
 * account chosen there is the one connected. Claude: the code Claude shows
 * goes to the computer by itself as soon as it lands in the field ("Colar",
 * a paste, typed or dropped) when it is this sign-in's; anything else waits
 * for "Enviar", with a line under it. Either way it is sealed here to the
 * computer's key. ChatGPT: device code sign-in allowed in its settings first,
 * then the device page and the one-time code to type there. A coding plan:
 * its own key page, then the key, sealed the same way; it never reaches our
 * server. "Colar" shows only while the field is empty. Every start is a click,
 * never the block showing. The page asks every 2 s; Voltar or closing stops
 * the sign-in on the computer. One key can go to several logins at once
 * (`fanOut`): each is begun, sealed to and watched on its own.
 */

/** Where ChatGPT allows signing in with a code (Settings › Security): Codex's device sign-in needs it. */
const CHATGPT_SECURITY = "https://chatgpt.com/#settings/Security";

export interface AddAccountProps {
  machineId: string;
  kind: MachineAccountKind;
  computer: string;
  /** A coding plan's key account on Claude Code. */
  provider?: PlanId;
  /** Sign in again to this account (signed out): same account, same agents. */
  again?: string;
  /**
   * Claude's login hint, never asked: the email of the account signing in again, or of the one a turn shares. A sign-in
   * that comes back as another account says so instead of thinking with it.
   */
  email?: string | null;
  /** The computer is one the person connected: its own browser may open the page itself. */
  local?: boolean;
  /** False while the computer isn't ready: nothing starts there yet, but the fields and the makers' pages work. */
  ready?: boolean;
  /** It just got ready and the page is still asking about it: what starts there shows it's loading. */
  loading?: boolean;
  /** The sign-in button's words when it signs in for one agent of several ("Sign in for Theo"). */
  signInLabel?: string;
  /**
   * A key sealed to one login per target: each agent of "All agents", or each login of an account getting a new
   * key (`again`).
   */
  fanOut?: { id: string; again?: string }[];
  /** Its own head, with Back; without it, the place that shows it says what it is. */
  onBack?: () => void;
  /** `target`: the `fanOut` target it signed in for. */
  onAdded: (account: MachineAccount, target?: string) => void;
  /**
   * Where an agent is in view: the sign-in came back as an account the person already connected there, signed in and
   * thinking for no agent, and it thinks for that agent instead ("Use x").
   */
  onUse?: (account: MachineAccount) => void;
  /** The code or the key went to the computer. */
  onSent?: () => void;
  /** A `fanOut` target's login ended without signing in (failed or expired). */
  onFailed?: (target: string) => void;
}

export function AddAccount(props: AddAccountProps) {
  // "Tentar de novo" starts over with a new sign-in: of a `fanOut`, only for the targets that didn't sign in, so no
  // login is left on the computer with none to think for.
  const [attempt, setAttempt] = useState(0);
  const [signedIn, setSignedIn] = useState<string[]>([]);
  const { fanOut, onAdded } = props;
  return (
    <AddAccountFlow
      key={attempt}
      {...props}
      {...(fanOut ? { fanOut: fanOut.filter((x) => !signedIn.includes(x.id)) } : {})}
      onAdded={(account, target) => {
        if (target) setSignedIn((s) => [...s, target]);
        onAdded(account, target);
      }}
      onRetry={() => setAttempt((n) => n + 1)}
    />
  );
}

/**
 * A step: its number on the title's line, the text under it, its button (or the wait) under its words, on the text's
 * column. Unnumbered where each step shows only once the one before it is done (Claude's sign-in, then its code): a
 * lone 1 counts nothing.
 */
export function Step({ n, children, side }: { n?: number; children: ReactNode; side?: ReactNode }) {
  return (
    <div className={cx("agp-addacct__step", n !== undefined && "ac-iconline")}>
      {n !== undefined && <i aria-hidden="true">{n}</i>}
      <span className="agp-addacct__text">{children}</span>
      {side}
    </div>
  );
}

/**
 * A step's title, its ⓘ right after it when it has one (outside the label, so pressing it never reaches the field);
 * `htmlFor`: the title names that field, which the hint (`hintId`) then also describes.
 */
export function StepTitle({
  title,
  hint,
  htmlFor,
  hintId,
}: {
  title: string;
  hint?: ReactNode;
  htmlFor?: string;
  hintId?: string;
}) {
  const { t } = useTranslation();
  const b = <b>{title}</b>;
  const label = htmlFor ? <label htmlFor={htmlFor}>{b}</label> : b;
  if (!hint) return label;
  return (
    <span className="ac-hintline">
      {label}
      <InfoHint name={t("common.about", { label: title })} id={hintId}>
        {hint}
      </InfoHint>
    </span>
  );
}

/** A maker's own page (a sign-in, its settings, where a key is made), opened from the click in a window of its own. */
export function OpenPage({
  href,
  primary,
  onOpened,
  children,
}: {
  href: string;
  primary?: boolean;
  onOpened?: () => void;
  children: ReactNode;
}) {
  return (
    <Button asChild size="sm" variant={primary ? "primary" : "default"}>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
          if (openPopup(href)) e.preventDefault();
          onOpened?.();
        }}
      >
        <Icon name="external" size={14} />
        {children}
      </a>
    </Button>
  );
}

function AddAccountFlow({
  machineId,
  kind,
  computer,
  provider,
  again,
  email: hint,
  local,
  ready = true,
  loading = false,
  signInLabel,
  fanOut,
  onBack,
  onAdded,
  onUse,
  onSent,
  onFailed,
  onRetry,
}: AddAccountProps & { onRetry: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const codeId = useId();
  const plan = planOf(provider);
  const [login, setLogin] = useState<AccountLoginStart | null>(null);
  const [starting, setStarting] = useState(false);
  const [startFailed, setStartFailed] = useState(false);
  const [opened, setOpened] = useState(false);
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const [pasteFailed, setPasteFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  // Signed in, but not as the account it was for (the hint): theirs to use or not.
  const [other, setOther] = useState<MachineAccount | null>(null);
  // The logins a key went to (`fanOut`), and the first of them that didn't end signed in.
  const [fan, setFan] = useState<{ id: string; loginId: string }[]>([]);
  const [fanFailed, setFanFailed] = useState<AccountLoginStatus | null>(null);
  const fanned = useRef<{ id: string; loginId: string }[]>([]);
  const fanEnded = useRef(new Set<string>());
  // The sign-ins still running and the computer each started on, where they're stopped when this block goes away:
  // the block shows while its computer is still being prepared, with no computer yet.
  const running = useRef<{ machineId: string; loginId: string }[]>([]);
  const gone = useRef(false);
  const reported = useRef(false);
  // With its own head, the dropdown that opened this block is gone: keyboard focus starts here. In a panel under a
  // picker, focus stays on the option the person just chose.
  const box = useRef<HTMLElement>(null);
  const headed = onBack !== undefined;
  useEffect(() => {
    if (headed) box.current?.focus();
  }, [headed]);
  const status = useAccountLogin(org.id, machineId, login?.loginId ?? null);
  const result = status.data;

  const begin = async (popup?: Window | null): Promise<AccountLoginStart | null> => {
    setStarting(true);
    setStartFailed(false);
    try {
      const l = await beginLogin((input) => api.machines.beginAccountLogin(org.id, machineId, kind, input), kind, {
        again,
        provider,
        hint,
      });
      if (gone.current) {
        void api.machines.cancelAccountLogin(org.id, machineId, l.loginId).catch(() => undefined);
        return null;
      }
      running.current = [...running.current, { machineId, loginId: l.loginId }];
      setLogin(l);
      if (popup) sendPopup(popup, l.url);
      return l;
    } catch {
      popup?.close();
      if (!gone.current) setStartFailed(true);
      return null;
    } finally {
      if (!gone.current) setStarting(false);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: one sign-in per mount ("Tentar de novo" remounts)
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
      const runs = running.current;
      running.current = [];
      for (const run of runs)
        void api.machines.cancelAccountLogin(org.id, run.machineId, run.loginId).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!result || result.state === "waiting" || !login) return;
    // Ended on the computer: nothing left to stop.
    running.current = running.current.filter((r) => r.loginId !== login.loginId);
    if (result.state === "done" && result.account && !reported.current) {
      reported.current = true;
      const got = result.account.email;
      if (hint && got && got.toLowerCase() !== hint.toLowerCase()) setOther(result.account);
      else onAdded(result.account);
    }
  }, [result, login, hint, onAdded]);

  /** One login a key went to (`fanOut`) ended on the computer. */
  const fanEnd = (loginId: string, end: AccountLoginStatus) => {
    if (fanEnded.current.has(loginId)) return;
    fanEnded.current.add(loginId);
    running.current = running.current.filter((r) => r.loginId !== loginId);
    const target = fanned.current.find((f) => f.loginId === loginId)?.id;
    if (end.state === "done" && end.account) onAdded(end.account, target);
    else {
      setFanFailed((first) => first ?? end);
      if (target) onFailed?.(target);
    }
  };

  const shown = fanFailed ?? result;
  const ended = startFailed || status.isError || shown?.state === "failed" || shown?.state === "expired";

  /** The code or the plan's key, sealed here to the computer's key for a sign-in. */
  const seal = async (l: AccountLoginStart | null, text: string) => {
    if (!l?.publicKey) throw new Error("no key");
    const sealed = await sealSecret(l.publicKey, text, accountCodeAad(l.loginId, org.id));
    await api.machines.sendAccountCode(org.id, machineId, l.loginId, sealed);
    void qc.invalidateQueries({ queryKey: keys.accountLogin(org.id, machineId, l.loginId) });
  };

  /** The code (Claude) or the plan's key: to this sign-in, or to one login per `fanOut` target not sent yet. */
  const send = async (value = code) => {
    const text = value.trim();
    if (!text || sending) return;
    setSending(true);
    setSendFailed(false);
    try {
      if (plan && fanOut) {
        for (const target of fanOut.filter((x) => !fanned.current.some((f) => f.id === x.id))) {
          const l = await api.machines.beginAccountLogin(org.id, machineId, kind, {
            provider,
            ...(target.again ? { accountId: target.again } : {}),
          });
          if (gone.current) {
            void api.machines.cancelAccountLogin(org.id, machineId, l.loginId).catch(() => undefined);
            return;
          }
          running.current = [...running.current, { machineId, loginId: l.loginId }];
          await seal(l, text);
          fanned.current = [...fanned.current, { id: target.id, loginId: l.loginId }];
          setFan(fanned.current);
        }
      } else await seal(login ?? (plan ? await begin() : null), text);
      setSent(true);
      setCode("");
      onSent?.();
    } catch {
      setSendFailed(true);
    } finally {
      setSending(false);
    }
  };

  /** What the field holds now, however it got there: a code of this sign-in goes to the computer by itself. */
  const take = (text: string) => {
    setCode(text);
    setSendFailed(false);
    if (!plan && login && isSignInCode(text, login.url)) void send(text);
  };

  const paste = async () => {
    setPasteFailed(false);
    let text = "";
    try {
      text = (await navigator.clipboard.readText()).trim();
    } catch {
      setPasteFailed(true);
      return;
    }
    if (text) take(text);
  };

  const copy = async () => {
    if (!login?.userCode) return;
    try {
      await navigator.clipboard?.writeText(login.userCode);
      setCopied(true);
    } catch {
      // The code stays on screen to type by hand.
    }
  };

  const waiting = (
    <span className="agp-addacct__wait" role="status">
      <Icon name="spinner" size={14} />
      {t("agentPage.work.brain.add.waiting")}
    </span>
  );
  const keyHintId = `${codeId}-hint`;
  // The field's buttons are its height (the ruler's default step), so the row reads as one line.
  const pasteRow = (label: string, placeholder: string | undefined, secret: boolean, valid: boolean) => (
    <>
      <span className="agp-addacct__paste">
        <Input
          id={codeId}
          type={secret ? "password" : "text"}
          value={code}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          aria-label={label}
          aria-describedby={plan ? keyHintId : undefined}
          disabled={sent}
          onChange={(e) => take(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (valid && ready && !loading) void send();
            }
          }}
        />
        {!code.trim() && (
          <Button icon="copy" disabled={sent} onClick={() => void paste()}>
            {t("aiAccounts.add.paste")}
          </Button>
        )}
        <Button
          variant="primary"
          loading={sending || loading}
          disabled={!valid || sent || !ready}
          onClick={() => void send()}
        >
          {t("agentPage.work.brain.add.send", { computer })}
        </Button>
      </span>
      {pasteFailed && <SettingNote icon="alert">{t("aiAccounts.add.pasteFailed")}</SettingNote>}
      {sendFailed && (
        <SettingNote icon="alert">
          {plan ? t("aiAccounts.add.keySendFailed") : t("agentPage.work.brain.add.sendFailed")}
        </SettingNote>
      )}
    </>
  );

  // Not the account it was for: one that came back done (`other`), or signing in again, which the server refuses.
  const otherEmail = other?.email ?? (hint ? shown?.signedInAs : undefined);
  const why = otherEmail
    ? t(`connectAi.otherAccount.${kind}`, { email: otherEmail, account: hint })
    : startFailed
      ? t("agentPage.work.brain.add.startFailed", { computer })
      : shown?.state === "expired"
        ? t("agentPage.work.brain.add.expired")
        : shown?.duplicate
          ? plan
            ? t("aiAccounts.add.duplicateKey", { account: shown.duplicate.label })
            : t(`agentPage.work.brain.add.duplicate.${kind}`, {
                account: shown.duplicate.account?.email ?? shown.duplicate.label,
              })
          : t("agentPage.work.brain.add.failed");

  const title = plan ? t("aiAccounts.add.titleKey", { plan: plan.label }) : t(`agentPage.work.brain.add.title.${kind}`);
  const key = code.trim();
  const keyOk = plan ? planKeyFits(plan, key) : key.length > 0;

  const retry = (
    <Button
      size="sm"
      icon="refresh"
      onClick={() => {
        // A new login that came back as another account goes; one signed in again stays the person's account.
        if (other && !again) void api.machines.removeAccount(org.id, machineId, other.id).catch(() => undefined);
        onRetry();
      }}
    >
      {t("common.retry")}
    </Button>
  );
  // What the person may think with instead: the account that came back (`other`), or, for the agent in view, one they
  // already connected there, signed in and thinking for no agent.
  const free = plan ? null : freeDuplicate(shown);
  const instead = other
    ? { account: other, use: () => onAdded(other) }
    : free && onUse
      ? { account: free, use: () => onUse(free) }
      : null;

  // Opened on the click itself, then sent to the provider's page once the computer has it.
  const start = () => {
    const popup = openPopup();
    setOpened(true);
    void begin(popup);
  };
  const openAgain = (url: string) => (
    <OpenPage href={url} onOpened={() => setOpened(true)}>
      {t("agentPage.work.brain.add.openAgain")}
    </OpenPage>
  );

  const signInHint = t("agentPage.work.brain.add.stepOneHint", { computer, brand: t(`aiAccounts.connect.${kind}`) });
  let steps: ReactNode;
  if (plan) {
    const site = new URL(plan.site);
    steps = (
      <>
        <Step
          n={1}
          side={
            <OpenPage href={plan.site} primary={!opened} onOpened={() => setOpened(true)}>
              {t("aiAccounts.add.openKeys", { site: site.host })}
            </OpenPage>
          }
        >
          <StepTitle
            title={t("aiAccounts.add.keyStep", { maker: plan.maker })}
            hint={provider === "zai" ? t("connectAi.zaiTeam") : undefined}
          />
        </Step>
        <Step n={2} side={sent ? waiting : undefined}>
          <StepTitle
            title={t("aiAccounts.add.keyTitle")}
            hint={t("aiAccounts.add.keySafe", { computer })}
            htmlFor={codeId}
            hintId={keyHintId}
          />
          {pasteRow(t("aiAccounts.add.keyLabel", { plan: plan.label }), plan.placeholder, true, keyOk)}
          {key && !keyOk && (
            <SettingNote icon="alert">{t("aiAccounts.add.keyShape", { plan: plan.label })}</SettingNote>
          )}
        </Step>
      </>
    );
  } else if (kind === "codex") {
    steps = (
      <>
        <Step n={1} side={<OpenPage href={CHATGPT_SECURITY}>{t("connectAi.chatgptCode.open")}</OpenPage>}>
          <b>{t("connectAi.chatgptCode.title")}</b>
          <span>{t("connectAi.chatgptCode.text")}</span>
        </Step>
        <Step
          n={2}
          side={
            login ? (
              openAgain(login.url)
            ) : (
              <Button
                size="sm"
                variant="primary"
                icon="external"
                loading={starting || loading}
                disabled={!ready}
                onClick={start}
              >
                {signInLabel ?? t("agentPage.work.brain.add.open.codex")}
              </Button>
            )
          }
        >
          <StepTitle title={t("agentPage.work.brain.add.stepOne.codex")} hint={signInHint} />
          {starting && <span>{t("agentPage.work.brain.add.starting", { computer })}</span>}
        </Step>
        {login?.userCode && (
          <Step n={3} side={waiting}>
            <b>{t("agentPage.work.brain.add.deviceCode")}</b>
            <span className="agp-addacct__code">
              <output aria-label={t("agentPage.work.brain.add.deviceCode")}>{login.userCode}</output>
              <Button size="sm" icon={copied ? "check" : "copy"} onClick={() => void copy()}>
                {copied ? t("common.copied") : t("common.copy")}
              </Button>
            </span>
            <span>{t("agentPage.work.brain.add.deviceCodeText")}</span>
          </Step>
        )}
      </>
    );
  } else {
    steps = (
      <>
        <Step
          side={
            login ? (
              openAgain(login.url)
            ) : (
              <Button
                size="sm"
                variant="primary"
                icon="external"
                loading={starting || loading}
                disabled={!ready}
                onClick={start}
              >
                {signInLabel ?? t("agentPage.work.brain.add.open.claude_code")}
              </Button>
            )
          }
        >
          <StepTitle title={t("agentPage.work.brain.add.stepOne.claude_code")} hint={signInHint} />
          {starting && <span>{t("agentPage.work.brain.add.starting", { computer })}</span>}
        </Step>
        {login && opened && (
          <Step side={waiting}>
            <label htmlFor={codeId}>
              <b>{t("agentPage.work.brain.add.stepTwo")}</b>
            </label>
            {pasteRow(
              t("agentPage.work.brain.add.codeLabel"),
              t("agentPage.work.brain.add.codeLabel"),
              false,
              key.length > 0,
            )}
            {key && !isSignInCode(key, login.url) && (
              <SettingNote icon="alert">{t("agentPage.work.brain.add.notCode")}</SettingNote>
            )}
            {(sent || local) && (
              <span>
                {sent
                  ? t("agentPage.work.brain.add.sent", { computer })
                  : t("agentPage.work.brain.add.local", { computer })}
              </span>
            )}
          </Step>
        )}
      </>
    );
  }

  return (
    <section ref={box} tabIndex={-1} className="agp-addacct" aria-label={title}>
      {onBack && (
        <div className="agp-addacct__head">
          <b className="row" style={{ gap: 8 }}>
            {plan && <ProviderLogo id={provider ?? ""} size="xs" />}
            {title}
          </b>
          <Button size="sm" variant="ghost" icon="chevronLeft" onClick={onBack}>
            {t("common.back")}
          </Button>
        </div>
      )}
      {other || ended ? (
        <div className="ai-panel__row">
          <SettingNote icon="alert" live>
            {why}
          </SettingNote>
          {instead ? (
            <span className="ac-acts">
              {retry}
              <Button size="sm" onClick={instead.use}>
                <span className="ai-panel__use">
                  {t("connectAi.useAnyway", { email: instead.account.email ?? instead.account.label })}
                </span>
              </Button>
            </span>
          ) : (
            retry
          )}
        </div>
      ) : (
        steps
      )}
      {fan.map((f) => (
        <LoginWatch key={f.loginId} machineId={machineId} loginId={f.loginId} onEnd={fanEnd} />
      ))}
    </section>
  );
}

/** One login a key went to, asked about every 2 s until it ends on the computer. */
function LoginWatch({
  machineId,
  loginId,
  onEnd,
}: {
  machineId: string;
  loginId: string;
  onEnd: (loginId: string, end: AccountLoginStatus) => void;
}) {
  const { org } = useOrg();
  const end = useAccountLogin(org.id, machineId, loginId).data;
  useEffect(() => {
    if (end && end.state !== "waiting") onEnd(loginId, end);
  }, [end, loginId, onEnd]);
  return null;
}
