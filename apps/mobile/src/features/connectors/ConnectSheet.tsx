import {
  APP_OAUTH_RETURN,
  type ConnectorDef,
  keys,
  useAgentAccess,
  useApi,
  useCatalog,
  useCompleteOAuth,
  useConnections,
  useConnectWithKey,
  useCustomServerAction,
  useCustomServers,
  useDisconnect,
  useStartOAuth,
} from "@agenteschat/client";
import { type Level, levelOf, resourcesOf, saveLevels } from "@agenteschat/client/lib/access-levels";
import { connectedItems } from "@agenteschat/client/lib/connected";
import { can } from "@agenteschat/client/lib/permissions";
import { connectorName, scopeText } from "@agenteschat/client/lib/scopes";
import { useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, LineIcon, Segmented, systemText, Text, useToast } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { successHaptic } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { ConnectorIcon } from "./ConnectorIcon";
import {
  type AuthAnswer,
  authAnswerOf,
  capabilityLines,
  connectHow,
  connectionOf,
  doneFinishing,
  isHttpsUrl,
  markFinishing,
  stateOf,
} from "./logic";

/** Where the browser brings the answer back (APP_OAUTH_REDIRECT on the server). */
const RETURN_URL = "agenteschat://connectors/oauth";

type Step = "about" | "connect" | "who";

/**
 * One service in a sheet over the gallery, in three steps: what agents could
 * do there (what always asks marked "pede sua aprovação") → connect (sign in in the browser and come back,
 * or paste a key) → who uses it and how far. A connected one opens on who uses it.
 */
export function ConnectSheet({ def }: { def: ConnectorDef }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const { org } = useOrg();
  const sheet = useSheet();
  const toast = useToast();
  const catalog = useCatalog();
  const connections = useConnections(orgId);
  const servers = useCustomServers(orgId);
  const disconnect = useDisconnect(orgId);
  const { disconnect: disconnectServer } = useCustomServerAction(orgId);
  const admin = can(org?.role, "configure");
  const existing = connectionOf(
    def,
    connectedItems(connections.data ?? [], servers.data ?? [], catalog.data?.connectors ?? [def]),
  );
  const [connectionId, setConnectionId] = useState<string | null>(existing?.id ?? null);
  const [step, setStep] = useState<Step>(existing ? "who" : "about");
  const name = connectorName(t, def);
  const tr = t as unknown as (key: string) => string;
  const lines = capabilityLines(tr, (k) => i18n.exists(k), def, (s) => scopeText(t, s).label);
  const index = step === "about" ? 0 : step === "connect" ? 1 : 2;
  return (
    <View style={styles.body}>
      <View style={styles.head}>
        <ConnectorIcon def={def} label={name} size={52} check={Boolean(connectionId)} />
        <View style={styles.grow}>
          <Text variant="title">{name}</Text>
          <Text variant="small" tone="muted">
            {t(`connectors.category.${def.category}`)}
          </Text>
        </View>
      </View>
      <Progress index={index} />
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
        <ConnectStep
          def={def}
          name={name}
          onConnected={(id) => {
            setConnectionId(id);
            setStep("who");
            successHaptic();
          }}
        />
      ) : connectionId ? (
        <>
          <Text variant="body" style={styles.bold}>
            {existing ? t("mobile.connectors.whoTitle") : t("mobile.connectors.connectedLine", { name })}
          </Text>
          <AgentLevels connectionId={connectionId} />
          {def.kind === "remote_mcp" ? (
            <Text variant="small" tone="muted">
              {t("mobile.connectors.reviewOnComputer")}
            </Text>
          ) : null}
          <SafeNote />
          <Button variant="primary" wide label={t("mobile.connectors.done")} onPress={sheet.close} />
          {admin && existing ? (
            <Button
              variant="ghost"
              wide
              label={t("mobile.connectors.disconnect")}
              disabled={disconnect.isPending || disconnectServer.isPending}
              onPress={() => {
                const done = {
                  onSuccess: () => {
                    sheet.close();
                    toast({ title: t("mobile.connectors.disconnected", { name }) });
                  },
                };
                // A server connected by address is removed through its own endpoint (as on the web).
                if (existing.custom) disconnectServer.mutate(existing.id, done);
                else disconnect.mutate(existing.id, done);
              }}
            />
          ) : null}
        </>
      ) : null}
    </View>
  );
}

/** "Conectar pelo endereço": any MCP server by its https address (sign in there, or a key when it asks). */
export function AddressSheet() {
  const { t } = useTranslation();
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const sheet = useSheet();
  return (
    <View style={styles.body}>
      <View style={styles.head}>
        <ConnectorIcon def={null} label="+" size={52} />
        <View style={styles.grow}>
          <Text variant="title">{t("mobile.connectors.addressTitle")}</Text>
          <Text variant="small" tone="muted">
            {t("mobile.connectors.addressHelp")}
          </Text>
        </View>
      </View>
      {connectionId ? (
        <>
          <AgentLevels connectionId={connectionId} />
          <Text variant="small" tone="muted">
            {t("mobile.connectors.reviewOnComputer")}
          </Text>
          <SafeNote />
          <Button variant="primary" wide label={t("mobile.connectors.done")} onPress={sheet.close} />
        </>
      ) : (
        <ConnectStep def={null} name="" onConnected={setConnectionId} />
      )}
    </View>
  );
}

/**
 * Connecting: sign in in the system browser (the server hands the answer back to the app, which finishes
 * with its own session) and/or paste a key. A catalog service that needs its server's address asks for it.
 */
function ConnectStep({
  def,
  name,
  onConnected,
}: {
  def: ConnectorDef | null;
  name: string;
  onConnected: (connectionId: string) => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const start = useStartOAuth(orgId);
  const complete = useCompleteOAuth(orgId);
  const withKey = useConnectWithKey(orgId);
  const { connect } = useCustomServerAction(orgId);
  const byAddress = def === null || def.kind === "remote_mcp";
  const askUrl = def === null || (def.kind === "catalog" && def.needsServerUrl);
  const how = def ? connectHow(def) : "either";
  const [mode, setMode] = useState<"signIn" | "key">(how === "key" ? "key" : "signIn");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busy = start.isPending || complete.isPending || withKey.isPending || connect.isPending;
  const serverUrl = def?.kind === "remote_mcp" ? (def.serverUrl ?? "") : url.trim();
  const shownName = name || serverUrl.replace(/^https:\/\//, "").split("/")[0] || "";

  const fail = () => setError(t("mobile.connectors.failed"));
  /** The browser round trip: open, wait for the answer, finish with the app's session. */
  const signInWith = async (authorizeUrl: string) => {
    const state = stateOf(authorizeUrl);
    if (state) markFinishing(state);
    try {
      const result = await WebBrowser.openAuthSessionAsync(authorizeUrl, RETURN_URL);
      if (result.type !== "success") return;
      const answer: AuthAnswer | null = authAnswerOf(result.url);
      if (!answer) return fail();
      if (answer.kind === "error") return setError(t("mobile.connectors.refused", { name: shownName }));
      const done = await complete.mutateAsync({ state: answer.state, code: answer.code });
      onConnected(done.connectionId);
    } catch {
      fail();
    } finally {
      if (state) doneFinishing(state);
    }
  };

  const signIn = async () => {
    setError(null);
    if (askUrl && !isHttpsUrl(url)) return setError(t("mobile.connectors.addressInvalid"));
    try {
      if (byAddress) {
        const res = await connect.mutateAsync({
          serverUrl,
          returnTo: APP_OAUTH_RETURN,
          ...(name ? { label: name } : {}),
        });
        if (res.status === "oauth") return void (await signInWith(res.authorizeUrl));
        if (res.status === "needs_key") {
          setMode("key");
          return setError(t("mobile.connectors.needsKey"));
        }
        return onConnected(res.server.id);
      }
      if (!def) return;
      const authorizeUrl = await start.mutateAsync({
        connector: def.id,
        returnTo: APP_OAUTH_RETURN,
        ...(askUrl ? { serverUrl } : {}),
      });
      await signInWith(authorizeUrl);
    } catch {
      fail();
    }
  };

  const submitKey = async () => {
    setError(null);
    if (askUrl && !isHttpsUrl(url)) return setError(t("mobile.connectors.addressInvalid"));
    if (key.trim().length < 8) return setError(t("mobile.connectors.keyShort"));
    try {
      if (byAddress) {
        const res = await connect.mutateAsync({
          serverUrl,
          apiKey: key.trim(),
          returnTo: APP_OAUTH_RETURN,
          ...(name ? { label: name } : {}),
        });
        if (res.status === "connected") return onConnected(res.server.id);
        return fail();
      }
      if (!def) return;
      const conn = await withKey.mutateAsync({
        connector: def.id,
        apiKey: key.trim(),
        ...(askUrl ? { serverUrl } : {}),
      });
      onConnected(conn.id);
    } catch {
      fail();
    }
  };

  const field = [styles.field, { backgroundColor: c.raised, color: c.ink, borderColor: c.line }];
  return (
    <>
      {askUrl ? (
        <View style={styles.fieldBox}>
          <Text variant="footnote" tone="faint">
            {t("mobile.connectors.addressLabel")}
          </Text>
          <TextInput
            value={url}
            onChangeText={setUrl}
            placeholder="https://"
            placeholderTextColor={c.faint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            accessibilityLabel={t("mobile.connectors.addressLabel")}
            style={field}
          />
        </View>
      ) : null}
      {how === "either" || (byAddress && mode === "key") ? (
        <Segmented
          items={[
            { key: "signIn", label: t("mobile.connectors.useSignIn") },
            { key: "key", label: t("mobile.connectors.useKey") },
          ]}
          value={mode}
          onChange={(k) => setMode(k as "signIn" | "key")}
        />
      ) : null}
      {mode === "signIn" ? (
        <>
          <Text variant="small" tone="muted">
            {t("mobile.connectors.signInHelp", { name: shownName })}
          </Text>
          <Button
            variant="primary"
            wide
            label={busy ? t("mobile.connectors.working") : t("mobile.connectors.signIn", { name: shownName })}
            disabled={busy}
            onPress={() => void signIn()}
          />
        </>
      ) : (
        <>
          <View style={styles.fieldBox}>
            <Text variant="footnote" tone="faint">
              {t("mobile.connectors.keyLabel", { name: shownName })}
            </Text>
            <View style={styles.keyRow}>
              <TextInput
                value={key}
                onChangeText={setKey}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel={t("mobile.connectors.keyLabel", { name: shownName })}
                style={[field, styles.grow]}
              />
              <Pressable
                onPress={() => void Clipboard.getStringAsync().then((v) => setKey(v.trim()))}
                accessibilityRole="button"
                accessibilityLabel={t("mobile.connectors.paste")}
                style={[styles.paste, { borderColor: c.line }]}
              >
                <Text variant="small" style={styles.bold}>
                  {t("mobile.connectors.paste")}
                </Text>
              </Pressable>
            </View>
            <View style={styles.note}>
              <LineIcon name="lock" size={14} color={c.faint} variant="small" />
              <Text variant="small" tone="muted" style={styles.grow}>
                {t("mobile.connectors.keyHelp")}
              </Text>
            </View>
          </View>
          <Button
            variant="primary"
            wide
            label={busy ? t("mobile.connectors.working") : t("mobile.connectors.connect")}
            disabled={busy}
            onPress={() => void submitKey()}
          />
        </>
      )}
      {busy ? <ActivityIndicator color={c.muted} /> : null}
      {error ? (
        <Text variant="small" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
    </>
  );
}

/** Who uses this connection and how far: one choice per agent (admins and each agent's owner change it). */
function AgentLevels({ connectionId }: { connectionId: string }) {
  const dir = useDirectory();
  const qc = useQueryClient();
  const orgId = useOrgId();
  // A new connection: every agent's tree must be read again to show it.
  useEffect(() => {
    void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "org" && q.queryKey[2] === "access" });
  }, [qc]);
  return (
    <View style={styles.agents}>
      {dir.agents.map((a) => (
        <AgentLevel key={a.id} orgId={orgId} agentId={a.id} connectionId={connectionId} />
      ))}
    </View>
  );
}

function AgentLevel({ orgId, agentId, connectionId }: { orgId: string; agentId: string; connectionId: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const dir = useDirectory();
  const meId = useMeId();
  const { org } = useOrg();
  const toast = useToast();
  const agent = dir.agentById.get(agentId);
  const access = useAgentAccess(orgId, agentId);
  const [saving, setSaving] = useState<Level | null>(null);
  const resource = access.data ? resourcesOf(access.data).find((r) => r.id === `connector:${connectionId}`) : undefined;
  const current = saving ?? (resource ? levelOf(resource) : "none");
  const mayChange = can(org?.role, "manage_agents") || Boolean(meId && agent?.ownerUserId === meId);
  const choose = (level: Level) => {
    if (!resource || level === current) return;
    setSaving(level);
    void saveLevels(api, orgId, agentId, { [resource.id]: level })
      .then((next) => qc.setQueryData(keys.agentAccess(orgId, agentId), next))
      .catch(() => toast({ title: t("mobile.connectors.failed"), icon: "x" }))
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
        {!mayChange || !resource ? (
          <Text variant="small" tone="muted">
            {t(`mobile.connectors.level.${current}`)}
          </Text>
        ) : null}
      </View>
      {mayChange && resource ? (
        <Segmented
          items={resource.levels.map((l) => ({ key: l, label: t(`mobile.connectors.level.${l}`) }))}
          value={current === "custom" ? "" : current}
          onChange={(k) => choose(k as Level)}
        />
      ) : null}
    </View>
  );
}

function SafeNote() {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <View style={styles.note}>
      <LineIcon name="shield" size={14} color={c.faint} variant="small" />
      <Text variant="small" tone="muted" style={styles.grow}>
        {t("mobile.connectors.safe")}
      </Text>
    </View>
  );
}

/** Three dashes: where the flow is (about, connect, who). */
function Progress({ index }: { index: number }) {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <View style={styles.progress} accessible accessibilityLabel={t("mobile.connectors.step", { n: index + 1 })}>
      {[0, 1, 2].map((i) => (
        <View key={i} style={[styles.dash, { backgroundColor: i <= index ? c.ink : c.line2 }]} />
      ))}
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
  progress: { flexDirection: "row", gap: 6 },
  dash: { flex: 1, height: 3, borderRadius: 2 },
  fieldBox: { gap: 6 },
  field: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
    ...systemText("body"),
  },
  keyRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  paste: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  note: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  agents: { gap: 10 },
  agent: { gap: 10, padding: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  agentHead: { flexDirection: "row", alignItems: "center", gap: 10 },
});
