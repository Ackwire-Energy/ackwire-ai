import { keys, useApi, useMailAccounts, useMailAction } from "@agenteschat/client";
import { LEVELS, type Level } from "@agenteschat/client/lib/access-levels";
import { choiceOf, fromMailLevel, MAIL_BRANDS, mailReviewTools, setMailLevel } from "@agenteschat/client/lib/mail";
import { can } from "@agenteschat/client/lib/permissions";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, Segmented, Text, useToast } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { errorHaptic, successHaptic } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { ConnectorIcon } from "./ConnectorIcon";
import { SafeNote } from "./ConnectSheet";
import { Problem } from "./Problem";
import { MailReview, ToolsRow } from "./ToolReview";

/**
 * A connected mailbox (any kind), opened from the gallery's connected row: who uses it and how far, what agents may
 * do in it (Ferramentas, in the sheet), and disconnecting it. Mailboxes connect on the web.
 */
export function MailboxSheet({ accountId }: { accountId: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const { org } = useOrg();
  const sheet = useSheet();
  const toast = useToast();
  const accounts = useMailAccounts(orgId);
  const { disconnect } = useMailAction(orgId);
  const admin = can(org, "manage_connectors");
  const [error, setError] = useState<string | null>(null);
  const [tools, setTools] = useState(false);
  const account = accounts.data?.find((a) => a.id === accountId);
  if (!account) return <ActivityIndicator color={c.muted} />;
  const choice = choiceOf(account);
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
  agents: { gap: 10 },
  agent: { gap: 10, padding: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  agentHead: { flexDirection: "row", alignItems: "center", gap: 10 },
});
