import type { AccountLoginStart, MachineAccount, MachineAccountKind } from "@agenteschat/client";
import { keys, useAccountLogin, useApi } from "@agenteschat/client";
import { errorCode } from "@agenteschat/client/lib/errors";
import { isSignInCode } from "@agenteschat/client/lib/machines";
import { type PlanId, planKeyFits, planOf } from "@agenteschat/client/lib/plans";
import { accountCodeAad } from "@agenteschat/client/lib/secret-box";
import { isEmail } from "@agenteschat/client/lib/text";
import { useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, TextInput, View } from "react-native";
import { sealSecret } from "@/lib/secret-box";
import { Button, fieldText, Text, useTheme } from "@/ui";
import { useAiOrg } from "./org";
import { Note, OpenPage, openPage, Step, StepsCard, StepText, Waiting } from "./parts";

/*
 * "Adicionar conta" as on the web (ADR 0041 §2, ADR 0059): the computer starts the provider's own sign-in and its
 * page opens here, in the in-app browser. Claude: the account to sign in to (optional) goes with the tap; the
 * code Claude shows comes back by "Colar" (sent by itself only when it is this sign-in's) or by hand, sealed on
 * the phone to the computer's key (ADR 0027). ChatGPT: device code sign-in allowed in its settings first, then
 * the device page and the one-time code to type there. A coding plan: its own key page, then the key, sealed the
 * same way; it never reaches our server. Every start is a tap; leaving stops the sign-in on the computer.
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
  /** Under the steps. */
  note?: ReactNode;
  onAdded: (account: MachineAccount) => void;
}

export function AddAccount(props: AddAccountProps) {
  // "Tentar de novo" starts over with a new sign-in.
  const [attempt, setAttempt] = useState(0);
  return <AddAccountFlow key={attempt} {...props} onRetry={() => setAttempt((n) => n + 1)} />;
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
  onAdded,
  onRetry,
}: AddAccountProps & { onRetry: () => void }) {
  const { t } = useTranslation();
  const { orgId } = useAiOrg();
  const api = useApi();
  const qc = useQueryClient();
  const { colors: c } = useTheme();
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
  const [copied, setCopied] = useState(false);
  // The sign-in still running and the computer it started on, stopped when this block goes away.
  const running = useRef<{ machineId: string; loginId: string } | null>(null);
  const gone = useRef(false);
  const reported = useRef(false);
  const status = useAccountLogin(orgId, machineId, login?.loginId ?? null);
  const result = status.data;
  // Inside the steps' white card a field sits sunken, as the paste row.
  const input = [styles.input, { color: c.ink, backgroundColor: c.sunken, borderColor: c.line }];

  const begin = async (): Promise<AccountLoginStart | null> => {
    setStarting(true);
    setStartFailed("");
    try {
      const typed = email.trim();
      const l = await api.machines.beginAccountLogin(orgId, machineId, kind, {
        ...(again ? { accountId: again } : {}),
        ...(kind === "claude_code" && !plan && typed ? { email: typed } : {}),
        ...(plan ? { provider } : {}),
      });
      if (gone.current) {
        void api.machines.cancelAccountLogin(orgId, machineId, l.loginId).catch(() => undefined);
        return null;
      }
      running.current = { machineId, loginId: l.loginId };
      setLogin(l);
      return l;
    } catch (error) {
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
      if (run) void api.machines.cancelAccountLogin(orgId, run.machineId, run.loginId).catch(() => undefined);
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
      const sealed = await sealSecret(l.publicKey, text, accountCodeAad(l.loginId, orgId));
      await api.machines.sendAccountCode(orgId, machineId, l.loginId, sealed);
      setSent(true);
      setCode("");
      void qc.invalidateQueries({ queryKey: keys.accountLogin(orgId, machineId, l.loginId) });
    } catch {
      setSendFailed(true);
    } finally {
      setSending(false);
    }
  };

  const paste = async () => {
    const text = (await Clipboard.getStringAsync().catch(() => "")).trim();
    if (!text) return;
    setCode(text);
    setSendFailed(false);
    if (!plan && login && isSignInCode(text, login.url)) void send(text);
  };

  const copy = async () => {
    if (!login?.userCode) return;
    await Clipboard.setStringAsync(login.userCode).catch(() => undefined);
    setCopied(true);
  };

  const waiting = <Waiting label={t("agentPage.work.brain.add.waiting")} />;
  const pasteRow = (label: string, placeholder: string, secret: boolean, valid: boolean) => (
    <>
      <View style={[styles.inset, { backgroundColor: c.sunken, borderColor: c.line }]}>
        <TextInput
          value={code}
          onChangeText={(v) => {
            setCode(v);
            setSendFailed(false);
          }}
          placeholder={placeholder}
          placeholderTextColor={c.faint}
          accessibilityLabel={label}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          secureTextEntry={secret}
          textContentType="none"
          editable={!sent}
          returnKeyType="send"
          onSubmitEditing={() => {
            if (valid) void send();
          }}
          style={[styles.insetInput, { color: c.ink }]}
        />
        <Button
          size="sm"
          variant="secondary"
          icon="copy"
          label={t("aiAccounts.add.paste")}
          disabled={sent}
          onPress={() => void paste()}
        />
      </View>
      <View style={styles.send}>
        <Button
          variant="primary"
          wide
          label={sending ? t("mobile.ai.saving") : t("agentPage.work.brain.add.send", { computer })}
          disabled={!valid || sent || !ready || sending}
          onPress={() => void send()}
        />
      </View>
      {sendFailed ? (
        <Note icon="x" live>
          {plan ? t("aiAccounts.add.keySendFailed") : t("agentPage.work.brain.add.sendFailed")}
        </Note>
      ) : null}
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

  const key = code.trim();
  const keyOk = plan ? planKeyFits(plan, key) : key.length > 0;

  // The computer starts the sign-in, then its page opens here.
  const start = async () => {
    setOpened(true);
    const l = await begin();
    if (l) openPage(l.url);
  };
  const openAgain = (url: string) => (
    <OpenPage href={url} label={t("agentPage.work.brain.add.openAgain")} onOpened={() => setOpened(true)} />
  );
  const startButton = (label: string, disabled: boolean) => (
    <Button
      size="sm"
      variant="primary"
      icon="out"
      label={label}
      disabled={disabled || starting}
      onPress={() => void start()}
    />
  );

  // Where the account stays and what to do on the wrong one: the sign-in step's ⓘ.
  const signInHint = t("agentPage.work.brain.add.stepOneHint", { computer });
  let steps: ReactNode;
  if (plan) {
    const site = new URL(plan.site);
    steps = (
      <>
        <Step
          n={1}
          state={opened ? "done" : "now"}
          title={t("aiAccounts.add.keyStep", { maker: plan.maker })}
          side={
            <OpenPage
              href={plan.site}
              primary={!opened}
              label={t("aiAccounts.add.openKeys", { site: site.host })}
              onOpened={() => setOpened(true)}
            />
          }
        >
          {provider === "zai" ? <StepText>{t("connectAi.zaiTeam")}</StepText> : null}
        </Step>
        <Step n={2} divider title={t("aiAccounts.add.keyTitle")} side={sent ? waiting : undefined}>
          {pasteRow(t("aiAccounts.add.keyLabel", { plan: plan.label }), "…", true, keyOk)}
          {key && !keyOk ? <Note icon="x">{t("aiAccounts.add.keyShape", { plan: plan.label })}</Note> : null}
          <StepText>{t("aiAccounts.add.keySafe", { computer })}</StepText>
        </Step>
      </>
    );
  } else if (kind === "codex") {
    steps = (
      <>
        <Step
          n={1}
          title={t("connectAi.chatgptCode.title")}
          side={<OpenPage href={CHATGPT_SECURITY} label={t("connectAi.chatgptCode.open")} />}
        >
          <StepText>{t("connectAi.chatgptCode.text")}</StepText>
        </Step>
        <Step
          n={2}
          divider
          state={login ? "done" : "now"}
          title={t("agentPage.work.brain.add.stepOne.codex")}
          hint={signInHint}
          side={login ? openAgain(login.url) : startButton(t("agentPage.work.brain.add.open.codex"), !ready)}
        >
          {starting ? <StepText>{t("agentPage.work.brain.add.starting", { computer })}</StepText> : null}
        </Step>
        {login?.userCode ? (
          <Step n={3} divider title={t("agentPage.work.brain.add.deviceCode")} side={waiting}>
            <View style={styles.code}>
              <Text
                variant="title2"
                selectable
                accessibilityLabel={t("agentPage.work.brain.add.deviceCode")}
                style={styles.codeText}
              >
                {login.userCode}
              </Text>
              <Button
                size="sm"
                variant="secondary"
                icon="copy"
                label={copied ? t("common.copied") : t("common.copy")}
                onPress={() => void copy()}
              />
            </View>
            <StepText>{t("agentPage.work.brain.add.deviceCodeText")}</StepText>
          </Step>
        ) : null}
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
          state={login && opened ? "done" : "now"}
          title={t("agentPage.work.brain.add.stepOne.claude_code")}
          hint={signInHint}
          side={
            login
              ? openAgain(login.url)
              : startButton(t("agentPage.work.brain.add.open.claude_code"), !emailOk || !ready)
          }
        >
          {starting ? <StepText>{t("agentPage.work.brain.add.starting", { computer })}</StepText> : null}
          {asks ? (
            <>
              <TextInput
                value={email}
                onChangeText={(v) => {
                  setEmail(v);
                  setStartFailed("");
                }}
                placeholder={t("aiAccounts.add.emailPlaceholder")}
                placeholderTextColor={c.faint}
                accessibilityLabel={t("aiAccounts.add.email")}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                textContentType="emailAddress"
                editable={!starting}
                style={input}
              />
              {startFailed === "email" || !emailOk ? <StepText>{t("aiAccounts.add.emailInvalid")}</StepText> : null}
            </>
          ) : null}
        </Step>
        {login && opened ? (
          <Step n={2} divider title={t("agentPage.work.brain.add.stepTwo")} side={sent ? waiting : undefined}>
            {pasteRow(
              t("agentPage.work.brain.add.codeLabel"),
              t("agentPage.work.brain.add.codeLabel"),
              false,
              key.length > 0,
            )}
            {sent || local ? (
              <StepText>
                {sent
                  ? t("agentPage.work.brain.add.sent", { computer })
                  : t("agentPage.work.brain.add.local", { computer })}
              </StepText>
            ) : null}
          </Step>
        ) : null}
      </>
    );
  }

  return (
    <View style={styles.flow}>
      {ended ? (
        <View style={styles.ended}>
          <Note icon="x" live>
            {why}
          </Note>
          <Button size="sm" variant="secondary" icon="undo" label={t("common.retry")} onPress={onRetry} />
        </View>
      ) : (
        <StepsCard>{steps}</StepsCard>
      )}
      {starting ? <ActivityIndicator color={c.muted} style={styles.spinner} /> : null}
      {note}
    </View>
  );
}

const styles = StyleSheet.create({
  flow: { gap: 10 },
  ended: { gap: 10, alignItems: "flex-start" },
  input: {
    minHeight: 46,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 6,
    ...fieldText("callout"),
  },
  inset: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 46,
    marginTop: 6,
    paddingLeft: 12,
    paddingRight: 5,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  insetInput: { flex: 1, minWidth: 0, paddingVertical: 8, ...fieldText("callout") },
  send: { marginTop: 10 },
  code: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10, marginVertical: 4 },
  codeText: { fontWeight: "700", letterSpacing: 2 },
  spinner: { alignSelf: "flex-start" },
});
