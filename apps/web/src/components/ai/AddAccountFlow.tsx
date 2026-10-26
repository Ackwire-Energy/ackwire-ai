import type { AccountLoginStart, MachineAccount, MachineAccountKind } from "@agenteschat/client";
import { keys, useAccountLogin, useApi } from "@agenteschat/client";
import { errorCode } from "@agenteschat/client/lib/errors";
import { isSignInCode } from "@agenteschat/client/lib/machines";
import { type PlanId, planKeyFits, planOf } from "@agenteschat/client/lib/plans";
import { accountCodeAad, sealSecret } from "@agenteschat/client/lib/secret-box";
import { isEmail } from "@agenteschat/client/lib/text";
import { Button, Icon, Input, ProviderLogo, SettingNote } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { openPopup, sendPopup } from "@/lib/popup";

/*
 * "Adicionar conta" (ADR 0041 §2, ADR 0059): the computer starts the
 * provider's own sign-in and its link opens here, in a window of its own.
 * Claude: the account to sign in to (optional) goes with the click; the code
 * Claude shows comes back by "Colar" (sent by itself only when it is this
 * sign-in's) or by hand, sealed here to the computer's key. ChatGPT: device
 * code sign-in allowed in its settings first, then the device page and the
 * one-time code to type there. A coding plan: its own key page, then the key,
 * sealed the same way; it never reaches our server. Every start is a click,
 * never the block showing. The page asks every 2 s; Voltar or closing stops
 * the sign-in on the computer.
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
  /** The account to sign in to (Claude), when it is already known. */
  email?: string | null;
  /** Claude: ask which account (the person already has one on that computer). Signing in again always asks. */
  askEmail?: boolean;
  /** The computer is one the person connected: its own browser may open the page itself. */
  local?: boolean;
  /** False while the computer isn't ready: nothing starts there yet, but the fields and the makers' pages work. */
  ready?: boolean;
  /** Under the steps, before where the account stays. */
  note?: ReactNode;
  /** Its own head, with Back; without it, the place that shows it says what it is. */
  onBack?: () => void;
  onAdded: (account: MachineAccount) => void;
}

export function AddAccount(props: AddAccountProps) {
  // "Tentar de novo" starts over with a new sign-in.
  const [attempt, setAttempt] = useState(0);
  return <AddAccountFlow key={attempt} {...props} onRetry={() => setAttempt((n) => n + 1)} />;
}

/** A numbered step: its number on the title's line, the text under it, its button at the side. */
export function Step({ n, children, side }: { n: number; children: ReactNode; side?: ReactNode }) {
  return (
    <div className="agp-addacct__step ac-iconline">
      <i aria-hidden="true">{n}</i>
      <span className="agp-addacct__text">{children}</span>
      {side}
    </div>
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
  email: knownEmail,
  askEmail,
  local,
  ready = true,
  note,
  onBack,
  onAdded,
  onRetry,
}: AddAccountProps & { onRetry: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const codeId = useId();
  const emailId = useId();
  const plan = planOf(provider);
  const [login, setLogin] = useState<AccountLoginStart | null>(null);
  const [starting, setStarting] = useState(false);
  const [startFailed, setStartFailed] = useState<"" | "start" | "email">("");
  const [opened, setOpened] = useState(false);
  const [email, setEmail] = useState(knownEmail ?? "");
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const [pasteFailed, setPasteFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  // The sign-in still running and the computer it started on, where it's stopped when this block goes away: the
  // block shows while its computer is still being prepared, with no computer yet.
  const running = useRef<{ machineId: string; loginId: string } | null>(null);
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
    setStartFailed("");
    try {
      const typed = email.trim();
      const l = await api.machines.beginAccountLogin(org.id, machineId, kind, {
        ...(again ? { accountId: again } : {}),
        ...(kind === "claude_code" && !plan && typed ? { email: typed } : {}),
        ...(plan ? { provider } : {}),
      });
      if (gone.current) {
        void api.machines.cancelAccountLogin(org.id, machineId, l.loginId).catch(() => undefined);
        return null;
      }
      running.current = { machineId, loginId: l.loginId };
      setLogin(l);
      if (popup) sendPopup(popup, l.url);
      return l;
    } catch (error) {
      popup?.close();
      if (!gone.current) setStartFailed(errorCode(error) === "account.invalid_email" ? "email" : "start");
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
      const run = running.current;
      running.current = null;
      if (run) void api.machines.cancelAccountLogin(org.id, run.machineId, run.loginId).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!result || result.state === "waiting") return;
    // Ended on the computer: nothing left to stop.
    running.current = null;
    if (result.state === "done" && result.account && !reported.current) {
      reported.current = true;
      onAdded(result.account);
    }
  }, [result, onAdded]);

  const ended = startFailed === "start" || status.isError || result?.state === "failed" || result?.state === "expired";

  /** The code (Claude) or the plan's key, sealed here to the computer's key for this sign-in. */
  const send = async (value = code) => {
    const text = value.trim();
    if (!text || sending) return;
    setSending(true);
    setSendFailed(false);
    try {
      const l = login ?? (plan ? await begin() : null);
      if (!l?.publicKey) throw new Error("no key");
      const sealed = await sealSecret(l.publicKey, text, accountCodeAad(l.loginId, org.id));
      await api.machines.sendAccountCode(org.id, machineId, l.loginId, sealed);
      setSent(true);
      setCode("");
      void qc.invalidateQueries({ queryKey: keys.accountLogin(org.id, machineId, l.loginId) });
    } catch {
      setSendFailed(true);
    } finally {
      setSending(false);
    }
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
    if (!text) return;
    setCode(text);
    setSendFailed(false);
    if (!plan && login && isSignInCode(text, login.url)) void send(text);
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
  const pasteRow = (label: string, placeholder: string, secret: boolean, valid: boolean) => (
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
          disabled={sent}
          onChange={(e) => {
            setCode(e.target.value);
            setSendFailed(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (valid) void send();
            }
          }}
        />
        <Button size="sm" icon="copy" disabled={sent} onClick={() => void paste()}>
          {t("aiAccounts.add.paste")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          loading={sending}
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

  const why =
    startFailed === "start"
      ? t("agentPage.work.brain.add.startFailed", { computer })
      : result?.state === "expired"
        ? t("agentPage.work.brain.add.expired")
        : result?.duplicate
          ? plan
            ? t("aiAccounts.add.duplicateKey", { account: result.duplicate.label })
            : t(`agentPage.work.brain.add.duplicate.${kind}`, { account: result.duplicate.label })
          : t("agentPage.work.brain.add.failed");

  const title = plan ? t("aiAccounts.add.titleKey", { plan: plan.label }) : t(`agentPage.work.brain.add.title.${kind}`);
  const key = code.trim();
  const keyOk = plan ? planKeyFits(plan, key) : key.length > 0;

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
          <b>{t("aiAccounts.add.keyStep", { maker: plan.maker })}</b>
          <span>{t("aiAccounts.add.keySite", { site: site.host })}</span>
          {provider === "zai" && <span>{t("connectAi.zaiTeam")}</span>}
        </Step>
        <Step n={2} side={sent ? waiting : undefined}>
          <label htmlFor={codeId}>
            <b>{t("aiAccounts.add.keyTitle")}</b>
          </label>
          {pasteRow(t("aiAccounts.add.keyLabel", { plan: plan.label }), "…", true, keyOk)}
          {key && !keyOk && (
            <SettingNote icon="alert">{t("aiAccounts.add.keyShape", { plan: plan.label })}</SettingNote>
          )}
          <span>{t("aiAccounts.add.keySafe", { computer })}</span>
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
              <Button size="sm" variant="primary" icon="external" loading={starting} disabled={!ready} onClick={start}>
                {t("agentPage.work.brain.add.open.codex")}
              </Button>
            )
          }
        >
          <b>{t("agentPage.work.brain.add.stepOne.codex")}</b>
          <span>
            {starting
              ? t("agentPage.work.brain.add.starting", { computer })
              : t("agentPage.work.brain.add.stepOneText.codex")}
          </span>
        </Step>
        {login?.userCode && (
          <Step n={3} side={waiting}>
            <b>{t("agentPage.work.brain.add.deviceCode")}</b>
            <span className="agp-addacct__code">
              <output aria-label={t("agentPage.work.brain.add.deviceCode")}>{login.userCode}</output>
              <Button size="sm" icon="copy" onClick={() => void copy()}>
                {copied ? t("common.copied") : t("common.copy")}
              </Button>
            </span>
            <span>{t("agentPage.work.brain.add.deviceCodeText")}</span>
          </Step>
        )}
      </>
    );
  } else {
    const typed = email.trim();
    const emailOk = !typed || isEmail(typed);
    // Which account, only where it helps: signing in again, or a second account beside one already there.
    const asks = !login && (askEmail || again !== undefined);
    steps = (
      <>
        <Step
          n={1}
          side={
            login ? (
              openAgain(login.url)
            ) : (
              <Button
                size="sm"
                variant="primary"
                icon="external"
                loading={starting}
                disabled={!emailOk || !ready}
                onClick={start}
              >
                {t("agentPage.work.brain.add.open.claude_code")}
              </Button>
            )
          }
        >
          <b>{t("agentPage.work.brain.add.stepOne.claude_code")}</b>
          <span>
            {starting
              ? t("agentPage.work.brain.add.starting", { computer })
              : t("agentPage.work.brain.add.stepOneText.claude_code")}
          </span>
          {asks && (
            <span className="agp-addacct__paste">
              <Input
                id={emailId}
                type="email"
                value={email}
                autoComplete="email"
                spellCheck={false}
                placeholder={t("aiAccounts.add.emailPlaceholder")}
                aria-label={t("aiAccounts.add.email")}
                disabled={starting}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setStartFailed("");
                }}
              />
            </span>
          )}
          {asks && (
            <span>
              {startFailed === "email" || !emailOk ? t("aiAccounts.add.emailInvalid") : t("aiAccounts.add.emailHelp")}
            </span>
          )}
        </Step>
        {login && opened && (
          <Step n={2} side={waiting}>
            <label htmlFor={codeId}>
              <b>{t("agentPage.work.brain.add.stepTwo")}</b>
            </label>
            {pasteRow(
              t("agentPage.work.brain.add.codeLabel"),
              t("agentPage.work.brain.add.codeLabel"),
              false,
              key.length > 0,
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
      {ended ? (
        <div className="agp-addacct__step">
          <SettingNote icon="alert" live>
            {why}
          </SettingNote>
          <Button size="sm" icon="refresh" onClick={onRetry}>
            {t("common.retry")}
          </Button>
        </div>
      ) : (
        steps
      )}
      {note}
      {!plan && <SettingNote icon="lock">{t("agentPage.work.brain.add.safe", { computer })}</SettingNote>}
    </section>
  );
}
