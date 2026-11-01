import {
  keys,
  type MailAccount,
  type MillionSendInbox,
  useApi,
  useMailAccounts,
  useMailAction,
  useMailProviders,
} from "@agenteschat/client";
import { LEVELS, type Level } from "@agenteschat/client/lib/access-levels";
import {
  choiceOf,
  fromMailLevel,
  MAIL_BRANDS,
  mailReviewTools,
  millionSendErrorText,
  setMailLevel,
} from "@agenteschat/client/lib/mail";
import { can } from "@agenteschat/client/lib/permissions";
import { useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { openBrowserAsync } from "expo-web-browser";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Linking, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, fieldText, GroupedList, GroupedRow, InfoHint, LineIcon, Segmented, Text, useToast } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { errorHaptic, successHaptic } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { ConnectorIcon } from "./ConnectorIcon";
import { Progress, SafeNote } from "./ConnectSheet";
import { capabilityLines } from "./logic";
import { Problem } from "./Problem";
import { CATALOG_STEPS, type Step } from "./review";
import { MailReview, ToolsRow } from "./ToolReview";

const MILLIONSEND_MARK = MAIL_BRANDS.millionsend ?? null;

/**
 * A MillionSend inbox in a sheet over the gallery, as on the web: what agents could do there → the key (the
 * MillionSend connector's, when it holds one and the person keeps it chosen, or one pasted) and which of its
 * inboxes → what agents may do in it → who uses it. The toast says whether new email reaches agents at once or
 * within minutes. The phone connects only this kind of mailbox; the others connect on the web.
 */
export function MillionSendSheet() {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const { org } = useOrg();
  const [step, setStep] = useState<Step>("about");
  const [account, setAccount] = useState<MailAccount | null>(null);
  const admin = can(org, "manage_connectors");
  const tr = t as unknown as (key: string) => string;
  const lines = capabilityLines(
    tr,
    (k) => i18n.exists(k),
    { id: "mail-millionsend", scopes: [] },
    () => "",
  );
  const name = t("mail.choice.millionsend.name");
  return (
    <View style={styles.body}>
      <View style={styles.head}>
        <ConnectorIcon def={MILLIONSEND_MARK} label={name} size={52} check={Boolean(account)} />
        <View style={styles.grow}>
          <Text variant="title">{name}</Text>
          <Text variant="small" tone="muted">
            {t("connectors.category.email")}
          </Text>
        </View>
      </View>
      <Progress steps={CATALOG_STEPS} step={step} />
      {step === "about" ? (
        <>
          <Text variant="footnote" tone="faint" style={styles.label}>
            {t("mobile.connectors.canTitle")}
          </Text>
          <View style={styles.caps}>
            {lines.map((l) => (
              <View key={l.text} style={styles.cap}>
                <LineIcon name={l.asks ? "shield" : "eye"} size={18} color={l.asks ? c.warn : c.muted} />
                <Text variant="body" style={styles.grow}>
                  {l.asks ? t("mobile.connectors.asks", { text: l.text }) : l.text}
                </Text>
              </View>
            ))}
          </View>
          {admin ? (
            <Button variant="primary" wide label={t("mobile.connectors.connect")} onPress={() => setStep("connect")} />
          ) : (
            <Text variant="small" tone="muted">
              {t("mobile.connectors.adminsOnly", { org: org?.name ?? "" })}
            </Text>
          )}
        </>
      ) : step === "connect" ? (
        <MillionSendConnect
          onConnected={(connected) => {
            setAccount(connected);
            setStep("review");
          }}
        />
      ) : account && step === "review" ? (
        <MailReview account={account} onNext={() => setStep("who")} />
      ) : account ? (
        <WhoUses accountId={account.id} />
      ) : null}
    </View>
  );
}

/** The key, then the inbox. */
function MillionSendConnect({ onConnected }: { onConnected: (account: MailAccount) => void }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const toast = useToast();
  const providers = useMailProviders(orgId);
  const { millionsendInboxes, connectMillionSend } = useMailAction(orgId);
  const ms = providers.data?.millionsend ?? null;
  const [source, setSource] = useState<"connector" | "paste" | null>(null);
  const chosen = source ?? (ms?.connectorKey ? "connector" : "paste");
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [inboxes, setInboxes] = useState<MillionSendInbox[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const keyInput = chosen === "connector" ? { useConnector: true } : { apiKey: key.trim() };
  const inboxId = picked ?? inboxes?.find((i) => !i.connected)?.id ?? null;
  const busy = millionsendInboxes.isPending || connectMillionSend.isPending;
  const oops = (text: string) => {
    errorHaptic();
    setError(text);
  };

  const read = async () => {
    setError(null);
    if (chosen === "paste" && key.trim().length < 8) return oops(t("mail.millionsend.keyInvalid"));
    try {
      setInboxes(await millionsendInboxes.mutateAsync(keyInput));
    } catch (e) {
      oops(millionSendErrorText(t, e));
    }
  };
  const connect = async () => {
    if (!inboxId) return;
    setError(null);
    try {
      const { account, instant } = await connectMillionSend.mutateAsync({ ...keyInput, inboxId });
      successHaptic();
      toast({
        title: t(instant ? "mail.millionsend.instant" : "mail.millionsend.polled", { address: account.address }),
      });
      onConnected(account);
    } catch (e) {
      oops(millionSendErrorText(t, e, inboxes?.find((i) => i.id === inboxId)?.address));
    }
  };

  if (inboxes) {
    return (
      <>
        <Text variant="body" style={styles.bold}>
          {t("mail.millionsend.pick")}
        </Text>
        {inboxes.length === 0 ? (
          <Problem text={t("mail.millionsend.none")} />
        ) : (
          <GroupedList>
            {inboxes.map((i) => (
              <GroupedRow
                key={i.id}
                label={i.address}
                {...(i.name && i.name !== i.address ? { sub: i.name } : {})}
                {...(i.connected ? { value: t("mail.millionsend.taken"), disabled: true } : {})}
                checked={i.id === inboxId}
                onPress={() => setPicked(i.id)}
              />
            ))}
          </GroupedList>
        )}
        <Button
          variant="primary"
          wide
          label={busy ? t("mobile.connectors.working") : t("mobile.connectors.connect")}
          disabled={busy || !inboxId}
          onPress={() => void connect()}
        />
        <Button variant="ghost" wide label={t("connectFlow.back")} onPress={() => setInboxes(null)} />
        {error ? <Problem key={error} text={error} /> : null}
      </>
    );
  }

  return (
    <>
      <Text variant="body" tone="muted">
        {t("mail.millionsend.text")}
      </Text>
      {ms?.connectorKey ? (
        <GroupedList>
          <GroupedRow
            label={t("mail.millionsend.useConnector")}
            sub={t("mail.millionsend.useConnectorText")}
            checked={chosen === "connector"}
            onPress={() => setSource("connector")}
          />
          <GroupedRow
            label={t("mail.millionsend.paste")}
            checked={chosen === "paste"}
            onPress={() => setSource("paste")}
          />
        </GroupedList>
      ) : null}
      {chosen === "paste" ? <KeyField value={key} onChange={setKey} keysUrl={ms?.keysUrl ?? null} /> : null}
      <Button
        variant="primary"
        wide
        label={busy ? t("mail.millionsend.reading") : t("connectFlow.next")}
        disabled={busy}
        onPress={() => void read()}
      />
      {busy ? <ActivityIndicator color={c.muted} /> : null}
      {error ? <Problem key={error} text={error} /> : null}
    </>
  );
}

/** "Chave de API do MillionSend": typed or pasted, with where MillionSend Cloud makes keys. */
function KeyField({
  value,
  onChange,
  keysUrl,
}: {
  value: string;
  onChange: (value: string) => void;
  keysUrl: string | null;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const label = t("mail.millionsend.key");
  return (
    <View style={styles.fieldBox}>
      <InfoHint name={t("common.about", { label })} text={t("mail.millionsend.keyHelp")} variant="footnote">
        <Text variant="footnote" tone="faint">
          {label}
        </Text>
      </InfoHint>
      <View style={styles.keyRow}>
        <TextInput
          value={value}
          onChangeText={onChange}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={label}
          style={[styles.field, { backgroundColor: c.raised, color: c.ink, borderColor: c.line }, styles.grow]}
        />
        <Pressable
          onPress={() => void Clipboard.getStringAsync().then((v) => onChange(v.trim()))}
          accessibilityRole="button"
          accessibilityLabel={t("mobile.connectors.paste")}
          style={[styles.paste, { borderColor: c.line }]}
        >
          <Text variant="small" style={styles.bold}>
            {t("mobile.connectors.paste")}
          </Text>
        </Pressable>
      </View>
      {keysUrl && /^https:\/\//.test(keysUrl) ? (
        <Pressable
          onPress={() => void openBrowserAsync(keysUrl).catch(() => Linking.openURL(keysUrl))}
          accessibilityRole="link"
          hitSlop={6}
          style={styles.link}
        >
          <LineIcon name="globe" size={14} color={c.muted} variant="small" />
          <Text variant="small" style={styles.bold}>
            {t("mail.millionsend.openKeys")}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * A connected mailbox (any kind), opened from the gallery's connected row: who uses it and how far, what agents may
 * do in it (Ferramentas, in the sheet), a MillionSend inbox's new key when MillionSend stopped accepting the old
 * one, and disconnecting it.
 */
export function MailboxSheet({ accountId }: { accountId: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const { org } = useOrg();
  const sheet = useSheet();
  const toast = useToast();
  const accounts = useMailAccounts(orgId);
  const providers = useMailProviders(orgId);
  const { update, disconnect } = useMailAction(orgId);
  const admin = can(org, "manage_connectors");
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tools, setTools] = useState(false);
  const account = accounts.data?.find((a) => a.id === accountId);
  if (!account) return <ActivityIndicator color={c.muted} />;
  const choice = choiceOf(account);
  const reconnect = admin && account.status === "needs_reconnect" && account.via === "millionsend";
  const fail = (text: string) => {
    errorHaptic();
    setError(text);
  };
  return (
    <View style={styles.body}>
      <View style={styles.head}>
        <ConnectorIcon def={MAIL_BRANDS[choice] ?? null} label={account.label} size={52} check />
        <View style={styles.grow}>
          <Text variant="title" numberOfLines={1}>
            {t(`mail.choice.${choice}.name`)}
          </Text>
          <Text variant="small" tone="muted" numberOfLines={1}>
            {account.status === "needs_reconnect"
              ? `${account.address} · ${t("mail.status.needs_reconnect")}`
              : account.address}
          </Text>
        </View>
      </View>
      {tools ? (
        <MailReview account={account} onNext={() => setTools(false)} onScreen />
      ) : (
        <>
          {reconnect ? (
            <>
              <Text variant="body" tone="muted">
                {t("mail.millionsend.reconnectText")}
              </Text>
              <KeyField value={key} onChange={setKey} keysUrl={providers.data?.millionsend?.keysUrl ?? null} />
              <Button
                variant="primary"
                wide
                label={update.isPending ? t("mobile.connectors.working") : t("mail.reconnect")}
                disabled={update.isPending}
                onPress={() => {
                  setError(null);
                  if (key.trim().length < 8) return fail(t("mail.millionsend.keyInvalid"));
                  update.mutate(
                    { accountId: account.id, apiKey: key.trim() },
                    {
                      onSuccess: (saved) => {
                        successHaptic();
                        setKey("");
                        toast({ title: t("mail.reconnected", { address: saved.address }) });
                      },
                      onError: (e) => fail(millionSendErrorText(t, e, account.address)),
                    },
                  );
                }}
              />
            </>
          ) : null}
          <WhoUses
            accountId={account.id}
            extra={
              admin ? <ToolsRow count={mailReviewTools(t, account).length} onPress={() => setTools(true)} /> : null
            }
          />
          {admin ? (
            <Button
              variant="ghost"
              wide
              label={t("mobile.connectors.disconnect")}
              disabled={disconnect.isPending}
              onPress={() => {
                setError(null);
                disconnect.mutate(account.id, {
                  onSuccess: () => {
                    successHaptic();
                    sheet.close();
                    toast({ title: t("mobile.connectors.disconnected", { name: account.address }) });
                  },
                  onError: () => fail(t("mobile.connectors.disconnectFailed", { name: account.address })),
                });
              }}
            />
          ) : null}
          {error ? <Problem key={error} text={error} /> : null}
        </>
      )}
    </View>
  );
}

/** Who uses a mailbox and how far, one level per agent; each change keeps that agent's rules there. */
function WhoUses({ accountId, extra }: { accountId: string; extra?: ReactNode }) {
  const { t } = useTranslation();
  const sheet = useSheet();
  const dir = useDirectory();
  return (
    <>
      <Text variant="body" style={styles.bold}>
        {t("mobile.connectors.whoTitle")}
      </Text>
      <View style={styles.agents}>
        {dir.agents.map((a) => (
          <AgentMailLevel key={a.id} agentId={a.id} accountId={accountId} />
        ))}
      </View>
      <SafeNote />
      {extra}
      <Button variant="primary" wide label={t("mobile.connectors.done")} onPress={sheet.close} />
    </>
  );
}

function AgentMailLevel({ agentId, accountId }: { agentId: string; accountId: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const orgId = useOrgId();
  const { org } = useOrg();
  const dir = useDirectory();
  const accounts = useMailAccounts(orgId);
  const agent = dir.agentById.get(agentId);
  const [saving, setSaving] = useState<Level | null>(null);
  const [failed, setFailed] = useState(false);
  const account = accounts.data?.find((a) => a.id === accountId);
  const current = saving ?? fromMailLevel(account?.agents.find((a) => a.agentId === agentId)?.level);
  // Giving an agent a mailbox is an admin's call, like its scopes (the server checks it again).
  const mayChange = can(org, "manage_agents");
  const choose = (level: Level) => {
    if (level === current) return;
    setSaving(level);
    setFailed(false);
    void setMailLevel(api, orgId, agentId, accountId, level)
      .then(() => qc.invalidateQueries({ queryKey: keys.mail(orgId) }))
      .catch(() => {
        errorHaptic();
        setFailed(true);
      })
      .finally(() => setSaving(null));
  };
  return (
    <View style={[styles.agent, { borderColor: c.line }]}>
      <View style={styles.agentHead}>
        <AgentFace agentId={agentId} size={30} live={false} />
        <View style={styles.grow}>
          <Text variant="body" numberOfLines={1} style={styles.bold}>
            {agent?.name ?? ""}
          </Text>
          {agent?.role ? (
            <Text variant="small" tone="muted" numberOfLines={1}>
              {agent.role}
            </Text>
          ) : null}
        </View>
        {mayChange ? null : (
          <Text variant="small" tone="muted">
            {t(`mobile.connectors.level.${current}`)}
          </Text>
        )}
      </View>
      {mayChange ? (
        <Segmented
          items={LEVELS.map((l) => ({ key: l, label: t(`mobile.connectors.level.${l}`) }))}
          value={current}
          onChange={(k) => choose(k as Level)}
        />
      ) : null}
      {failed ? <Problem text={t("mobile.connectors.levelFailed", { name: agent?.name ?? "" })} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: 14 },
  head: { flexDirection: "row", alignItems: "center", gap: 12 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  label: { letterSpacing: 0.3 },
  caps: { gap: 10 },
  cap: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  fieldBox: { gap: 6 },
  field: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
    ...fieldText("body"),
  },
  keyRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  paste: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  link: { flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "flex-start", marginTop: 4 },
  agents: { gap: 10 },
  agent: { gap: 10, padding: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  agentHead: { flexDirection: "row", alignItems: "center", gap: 10 },
});
