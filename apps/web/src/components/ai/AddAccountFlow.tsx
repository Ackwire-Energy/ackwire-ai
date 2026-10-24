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
 * sign-in's) or by hand, sealed here to the computer's key. Codex: the device
 * page and the one-time code to type there. A coding plan: its own key page,
 * then the key, sealed the same way; it never reaches our server. The page
 * asks every 2 s; Voltar or closing stops the sign-in on the computer.
 */

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
  onBack: () => void;
  onAdded: (account: MachineAccount) => void;
}

export function AddAccount(props: AddAccountProps) {
  // "Tentar de novo" starts over with a new sign-in.
  const [attempt, setAttempt] = useState(0);
  return <AddAccountFlow key={attempt} {...props} onRetry={() => setAttempt((n) => n + 1)} />;
}

function Step({ n, children, side }: { n: number; children: ReactNode; side?: ReactNode }) {
  return (
    <div className="agp-addacct__step">
      <i aria-hidden="true">{n}</i>
      <span className="agp-addacct__text">{children}</span>
      {side}
    </div>
  );
}

function AddAccountFlow({
  machineId,
  kind,
  computer,
  provider,
  again,
  email: knownEmail,
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
  // The sign-in still running on the computer: stopped when this block goes away.
  const running = useRef<string | null>(null);
  const gone = useRef(false);
  const reported = useRef(false);
  // The dropdown that opened this block is gone: keyboard focus starts here.
  const box = useRef<HTMLElement>(null);
  useEffect(() => box.current?.focus(), []);
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
      running.current = l.loginId;
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
    // Codex's code is what the person types: it starts at once. Claude starts on its button (with the account
    // to sign in to), a plan once its key is pasted.
    if (kind === "codex") void begin();
    return () => {
      gone.current = true;
      const id = running.current;
      running.current = null;
      if (id) void api.machines.cancelAccountLogin(org.id, machineId, id).catch(() => undefined);
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
        <Button size="sm" variant="primary" loading={sending} disabled={!valid || sent} onClick={() => void send()}>
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

  let steps: ReactNode;
  if (plan) {
    const site = new URL(plan.site);
    steps = (
      <>
        <Step
          n={1}
          side={
            <Button asChild size="sm" variant={opened ? "default" : "primary"}>
              <a
                href={plan.site}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  if (openPopup(plan.site)) e.preventDefault();
                  setOpened(true);
                }}
              >
                <Icon name="external" size={14} />
                {t("aiAccounts.add.openKeys", { site: site.host })}
              </a>
            </Button>
          }
        >
          <b>{t("aiAccounts.add.keyStep", { maker: plan.maker })}</b>
          <span>{t("aiAccounts.add.keySite", { site: site.host })}</span>
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
        <Step
          n={1}
          side={
            login ? (
              <Button asChild size="sm" variant={opened ? "default" : "primary"}>
                <a
                  href={login.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => {
                    if (openPopup(login.url)) e.preventDefault();
                    setOpened(true);
                  }}
                >
                  <Icon name="external" size={14} />
                  {opened ? t("agentPage.work.brain.add.openAgain") : t("agentPage.work.brain.add.open.codex")}
                </a>
              </Button>
            ) : (
              <Button size="sm" variant="primary" loading disabled>
                {t("agentPage.work.brain.add.open.codex")}
              </Button>
            )
          }
        >
          <b>{t("agentPage.work.brain.add.stepOne.codex")}</b>
          <span>
            {login
              ? t("agentPage.work.brain.add.stepOneText.codex")
              : t("agentPage.work.brain.add.starting", { computer })}
          </span>
        </Step>
        {login?.userCode && (
          <Step n={2} side={waiting}>
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
    steps = (
      <>
        <Step
          n={1}
          side={
            login ? (
              <Button asChild size="sm">
                <a
                  href={login.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => {
                    if (openPopup(login.url)) e.preventDefault();
                    setOpened(true);
                  }}
                >
                  <Icon name="external" size={14} />
                  {t("agentPage.work.brain.add.openAgain")}
                </a>
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                icon="external"
                loading={starting}
                disabled={!emailOk}
                onClick={() => {
                  // Opened on the click itself, then sent to Claude's page once the computer has it.
                  const popup = openPopup();
                  setOpened(true);
                  void begin(popup);
                }}
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
          {!login && (
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
          {!login && (
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
            <span>
              {sent
                ? t("agentPage.work.brain.add.sent", { computer })
                : t("agentPage.work.brain.add.local", { computer })}
            </span>
          </Step>
        )}
      </>
    );
  }

  return (
    <section ref={box} tabIndex={-1} className="agp-addacct" aria-label={title}>
      <div className="agp-addacct__head">
        <b className="row" style={{ gap: 8 }}>
          {plan && <ProviderLogo id={provider ?? ""} size="xs" />}
          {title}
        </b>
        <Button size="sm" variant="ghost" icon="chevronLeft" onClick={onBack}>
          {t("common.back")}
        </Button>
      </div>
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
      {!plan && <SettingNote icon="lock">{t("agentPage.work.brain.add.safe", { computer })}</SettingNote>}
    </section>
  );
}
