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
import {
  LEVELS,
  type Level,
  levelIn,
  levelOf,
  resourcesOf,
  saveLevels,
  sharedLevel,
} from "@agenteschat/client/lib/access-levels";
import { type ConnectedItem, connectedItems, itemName } from "@agenteschat/client/lib/connected";
import { can } from "@agenteschat/client/lib/permissions";
import { connectorName, scopeText } from "@agenteschat/client/lib/scopes";
import { useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from "react-native";
import Animated, { FadeIn, ZoomIn } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import { Button, fieldText, Icon, InfoHint, LineIcon, Segmented, Text, useTheme, useToast } from "@/ui";
import { useAgentsAccess, useSetLevels } from "../settings/hooks";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { errorHaptic, successHaptic, Tile } from "../shared/parts";
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
import { Problem } from "./Problem";
import { ADDRESS_STEPS, CATALOG_STEPS, firstStep, STEP_KEYS, type Step } from "./review";
import { ReviewStep } from "./ToolReview";
import { openTools } from "./ToolsScreen";

/** Where the browser brings the answer back (APP_OAUTH_REDIRECT on the server). */
const RETURN_URL = "agenteschat://connectors/oauth";

/**
 * One service in a sheet over the gallery, in four steps as on the web: what agents could do there (what
 * always asks marked "pede sua aprovação") → connect (sign in in the browser and come back, or paste a key) →
 * its tools ("O que faz") → who uses it and how far. A connected one opens on who uses it (its tools are a screen
 * of their own; `item`: that connection, when the service is connected more than once; `start`, back from a
 * sign-in that finished elsewhere, with `fresh` saying it just connected).
 */
export function ConnectSheet({
  def,
  item,
  start,
  fresh = false,
}: {
  def: ConnectorDef;
  item?: ConnectedItem;
  start?: Step;
  fresh?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const { org } = useOrg();
  const orgId = useOrgId();
  const catalog = useCatalog();
  const connections = useConnections(orgId);
  const servers = useCustomServers(orgId);
  const admin = can(org, "manage_connectors");
  const existing =
    item ??
    connectionOf(def, connectedItems(connections.data ?? [], servers.data ?? [], catalog.data?.connectors ?? [def]));
  const [connectionId, setConnectionId] = useState<string | null>(existing?.id ?? null);
  const [step, setStep] = useState<Step>(() => firstStep(existing, admin, start));
  // Connected in this sheet: it says so on top of its tools (the list catching up must not take that away).
  const [justConnected, setJustConnected] = useState(fresh);
  const name = connectorName(t, def);
  const tr = t as unknown as (key: string) => string;
  const lines = capabilityLines(
    tr,
    (k) => i18n.exists(k),
    def,
    (s) => scopeText(t, s).label,
  );
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
        <ConnectStep
          def={def}
          name={name}
          onConnected={(id) => {
            setConnectionId(id);
            setJustConnected(true);
            setStep("review");
          }}
        />
      ) : connectionId ? (
        <ConnectedSteps
          step={step}
          onStep={setStep}
          connectionId={connectionId}
          def={def}
          name={name}
          justConnected={justConnected}
          item={existing}
        />
      ) : null}
    </View>
  );
}

/** "Conectar pelo endereço": any MCP server by its https address (sign in there, or a key when it asks). */
export function AddressSheet() {
  const { t } = useTranslation();
  const [connected, setConnected] = useState<{ id: string; name: string } | null>(null);
  const [step, setStep] = useState<Step>("connect");
  return (
    <View style={styles.body}>
      <View style={styles.head}>
        <ConnectorIcon def={null} label={connected?.name ?? "+"} size={52} check={Boolean(connected)} />
        <View style={styles.grow}>
          <Text variant="title">{t("mobile.connectors.addressTitle")}</Text>
          <Text variant="small" tone="muted">
            {t("mobile.connectors.addressHelp")}
          </Text>
        </View>
      </View>
      <Progress steps={ADDRESS_STEPS} step={step} />
      {connected ? (
        <ConnectedSteps
          step={step}
          onStep={setStep}
          connectionId={connected.id}
          def={null}
          name={connected.name}
          justConnected
        />
      ) : (
        <ConnectStep
          def={null}
          name=""
          onConnected={(id, name) => {
            setConnected({ id, name });
            setStep("review");
          }}
        />
      )}
    </View>
  );
}

/**
 * A server connected by its address that isn't in the catalog: its name and address, then its tools and who
 * uses it (the same steps as connecting it), and disconnecting it.
 */
export function ServerSheet({ item, start, fresh = false }: { item: ConnectedItem; start?: Step; fresh?: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const admin = can(org, "manage_connectors");
  const [step, setStep] = useState<Step>(() => firstStep(item, admin, start));
  const name = itemName(t, item);
  return (
    <View style={styles.body}>
      <View style={styles.head}>
        <ConnectorIcon def={item.def} image={item.image} label={name} size={52} check />
        <View style={styles.grow}>
          <Text variant="title" numberOfLines={1}>
            {name}
          </Text>
          {item.account ? (
            <Text variant="small" tone="muted" numberOfLines={1}>
              {item.account}
            </Text>
          ) : null}
        </View>
      </View>
      <Progress steps={ADDRESS_STEPS} step={step} />
      <ConnectedSteps
        step={step}
        onStep={setStep}
        connectionId={item.id}
        def={item.def}
        name={name}
        justConnected={fresh}
        item={item}
      />
    </View>
  );
}

/**
 * After connecting, the web's last two steps: its tools ("O que faz", then Continuar) and who uses it (one level
 * per agent). From who uses it admins open the tools on their own screen, as the web's "Ferramentas" (or
 * "Revisar" while they wait); anyone else is told when they still wait for an admin.
 */
function ConnectedSteps({
  step,
  onStep,
  connectionId,
  def,
  name,
  justConnected,
  item,
}: {
  step: Step;
  onStep: (step: Step) => void;
  connectionId: string;
  def: ConnectorDef | null;
  name: string;
  justConnected: boolean;
  /** The connection as it was opened (the live lists win once they have it). */
  item?: ConnectedItem;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const sheet = useSheet();
  const orgId = useOrgId();
  const catalog = useCatalog();
  const connections = useConnections(orgId);
  const servers = useCustomServers(orgId);
  const admin = can(org, "manage_connectors");
  const live =
    connectedItems(connections.data ?? [], servers.data ?? [], catalog.data?.connectors ?? []).find(
      (i) => i.id === connectionId,
    ) ?? item;
  if (step === "review") {
    return (
      <>
        {justConnected ? <ConnectedNote name={name} /> : null}
        <ReviewStep connectionId={connectionId} def={def} name={name} onNext={() => onStep("who")} />
      </>
    );
  }
  return (
    <>
      <Text variant="body" style={styles.bold}>
        {t("mobile.connectors.whoTitle")}
      </Text>
      <AgentLevels connectionId={connectionId} />
      {live?.needsReview && !admin ? (
        <Text variant="small" tone="muted">
          {t("mobile.connectors.review.waiting")}
        </Text>
      ) : null}
      <SafeNote />
      <Button variant="primary" wide label={t("mobile.connectors.done")} onPress={sheet.close} />
      {admin ? (
        <Button
          variant="ghost"
          wide
          label={live?.needsReview ? t("connectors.review") : t("connectors.tools")}
          onPress={() => {
            sheet.close();
            openTools(connectionId);
          }}
        />
      ) : null}
      {admin && live ? <DisconnectButton item={live} name={name} onDone={sheet.close} /> : null}
    </>
  );
}

/**
 * Disconnecting: `onDone` leaves (the sheet closes, the screen goes back) with a note on the screen behind it, or
 * it says in place that it failed.
 */
export function DisconnectButton({ item, name, onDone }: { item: ConnectedItem; name: string; onDone: () => void }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const disconnect = useDisconnect(orgId);
  const { disconnect: disconnectServer } = useCustomServerAction(orgId);
  const [failed, setFailed] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        wide
        label={t("mobile.connectors.disconnect")}
        disabled={disconnect.isPending || disconnectServer.isPending}
        onPress={() => {
          setFailed(false);
          const done = {
            onSuccess: () => {
              successHaptic();
              onDone();
              toast({ title: t("mobile.connectors.disconnected", { name }) });
            },
            onError: () => {
              errorHaptic();
              setFailed(true);
            },
          };
          // A server connected by address is removed through its own endpoint (as on the web).
          if (item.custom) disconnectServer.mutate(item.id, done);
          else disconnect.mutate(item.id, done);
        }}
      />
      {failed ? <Problem text={t("mobile.connectors.disconnectFailed", { name })} /> : null}
    </>
  );
}

/** Just connected: a check that pops in (the phone buzzes with it), the name and what comes next. */
function ConnectedNote({ name }: { name: string }) {
  const { t } = useTranslation();
  const { colors, reducedMotion } = useTheme();
  return (
    <Animated.View
      entering={reducedMotion ? undefined : FadeIn.duration(220)}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[styles.note, styles.notice, { borderColor: colors.line }]}
    >
      <Animated.View
        entering={reducedMotion ? undefined : ZoomIn.springify().damping(12)}
        style={[styles.badge, { backgroundColor: colors.ok }]}
      >
        <Icon name="check" size={16} color="#ffffff" />
      </Animated.View>
      <View style={styles.grow}>
        <Text variant="body" style={styles.bold}>
          {t("mobile.connectors.connectedTitle", { name })}
        </Text>
        <Text variant="small" tone="muted">
          {t("mobile.connectors.connectedSub")}
        </Text>
      </View>
    </Animated.View>
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
  onConnected: (connectionId: string, name: string) => void;
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
  const keyLabel = t("mobile.connectors.keyLabel", { name: shownName });

  // Every ending is felt as well as seen: a success buzz with the sheet moving on, an error buzz with the
  // reason in the sheet.
  const connected = (id: string, label: string) => {
    successHaptic();
    onConnected(id, label || shownName);
  };
  const oops = (text: string) => {
    errorHaptic();
    setError(text);
  };
  const fail = () => oops(t("mobile.connectors.failed"));
  /** The browser round trip: open, wait for the answer, finish with the app's session. */
  const signInWith = async (authorizeUrl: string) => {
    const state = stateOf(authorizeUrl);
    if (state) markFinishing(state);
    try {
      const result = await WebBrowser.openAuthSessionAsync(authorizeUrl, RETURN_URL);
      if (result.type !== "success") return;
      const answer: AuthAnswer | null = authAnswerOf(result.url);
      if (!answer) return fail();
      if (answer.kind === "error") return oops(t("mobile.connectors.refused", { name: shownName }));
      const done = await complete.mutateAsync({ state: answer.state, code: answer.code });
      connected(done.connectionId, name);
    } catch {
      fail();
    } finally {
      if (state) doneFinishing(state);
    }
  };

  const signIn = async () => {
    setError(null);
    if (askUrl && !isHttpsUrl(url)) return oops(t("mobile.connectors.addressInvalid"));
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
          return oops(t("mobile.connectors.needsKey"));
        }
        return connected(res.server.id, name || res.server.label);
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
    if (askUrl && !isHttpsUrl(url)) return oops(t("mobile.connectors.addressInvalid"));
    if (key.trim().length < 8) return oops(t("mobile.connectors.keyShort"));
    try {
      if (byAddress) {
        const res = await connect.mutateAsync({
          serverUrl,
          apiKey: key.trim(),
          returnTo: APP_OAUTH_RETURN,
          ...(name ? { label: name } : {}),
        });
        if (res.status === "connected") return connected(res.server.id, name || res.server.label);
        return fail();
      }
      if (!def) return;
      const conn = await withKey.mutateAsync({
        connector: def.id,
        apiKey: key.trim(),
        ...(askUrl ? { serverUrl } : {}),
      });
      connected(conn.id, name);
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
        <Button
          variant="primary"
          wide
          label={busy ? t("mobile.connectors.working") : t("mobile.connectors.signIn", { name: shownName })}
          disabled={busy}
          onPress={() => void signIn()}
        />
      ) : (
        <>
          <View style={styles.fieldBox}>
            <InfoHint
              name={t("common.about", { label: keyLabel })}
              text={t("mobile.connectors.keyHelp")}
              variant="footnote"
            >
              <Text variant="footnote" tone="faint">
                {keyLabel}
              </Text>
            </InfoHint>
            <View style={styles.keyRow}>
              <TextInput
                value={key}
                onChangeText={setKey}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel={keyLabel}
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
      {error ? <Problem key={error} text={error} /> : null}
    </>
  );
}

/**
 * Who uses this connection and how far: "Todos os agentes" first (admins: it sets every agent), then one choice per
 * agent (admins and each agent's owner change it).
 */
export function AgentLevels({ connectionId }: { connectionId: string }) {
  const dir = useDirectory();
  const qc = useQueryClient();
  const orgId = useOrgId();
  const { org } = useOrg();
  // A new connection: every agent's tree must be read again to show it.
  useEffect(() => {
    void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "org" && q.queryKey[2] === "access" });
  }, [qc]);
  return (
    <View style={styles.agents}>
      {dir.agents.length > 1 && can(org, "manage_agents") ? <EveryoneLevel connectionId={connectionId} /> : null}
      {dir.agents.map((a) => (
        <AgentLevel key={a.id} orgId={orgId} agentId={a.id} connectionId={connectionId} />
      ))}
    </View>
  );
}

/** "Todos os agentes": the main choice, as an agent's row; picking a level saves it for every agent, one by one. */
function EveryoneLevel({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const access = useAgentsAccess(dir.agents);
  const set = useSetLevels();
  const [saving, setSaving] = useState<Level | null>(null);
  const [failed, setFailed] = useState(false);
  const resourceId = `connector:${connectionId}`;
  const levels = dir.agents.map((a) => levelIn(access.byAgent.get(a.id), resourceId));
  const current = saving ?? (access.loading ? null : sharedLevel(levels));
  const choose = async (level: Level) => {
    if (saving || access.loading || level === current) return;
    setSaving(level);
    setFailed(false);
    try {
      for (const [i, a] of dir.agents.entries()) {
        if (levels[i] !== level) await set.mutateAsync({ agentId: a.id, changes: { [resourceId]: level } });
      }
    } catch {
      errorHaptic();
      setFailed(true);
    } finally {
      setSaving(null);
    }
  };
  return (
    <View style={[styles.agent, styles.everyone, { borderColor: c.line2, backgroundColor: c.raised }]}>
      <View style={styles.agentHead}>
        <Tile icon="members" size={30} />
        <View style={styles.grow}>
          <Text variant="body" numberOfLines={1} style={styles.bold}>
            {t("connectFlow.everyone")}
          </Text>
          <Text variant="small" tone="muted" numberOfLines={1}>
            {t("connectFlow.everyoneCount", { count: dir.agents.length })}
          </Text>
        </View>
      </View>
      <Segmented
        items={LEVELS.map((l) => ({ key: l, label: t(`mobile.connectors.level.${l}`) }))}
        value={current === "custom" || current === null ? "" : current}
        onChange={(k) => void choose(k as Level)}
      />
      {failed ? <Problem text={t("mobile.connectors.everyoneFailed")} /> : null}
    </View>
  );
}

function AgentLevel({ orgId, agentId, connectionId }: { orgId: string; agentId: string; connectionId: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const dir = useDirectory();
  const { org } = useOrg();
  const agent = dir.agentById.get(agentId);
  const access = useAgentAccess(orgId, agentId);
  const [saving, setSaving] = useState<Level | null>(null);
  const [failed, setFailed] = useState(false);
  const resource = access.data ? resourcesOf(access.data).find((r) => r.id === `connector:${connectionId}`) : undefined;
  const current = saving ?? (resource ? levelOf(resource) : "none");
  // Giving an agent a connector is an admin's call, like its scopes (the server checks it again).
  const mayChange = can(org, "manage_agents");
  const choose = (level: Level) => {
    if (!resource || level === current) return;
    setSaving(level);
    setFailed(false);
    void saveLevels(api, orgId, agentId, { [resource.id]: level })
      .then((next) => qc.setQueryData(keys.agentAccess(orgId, agentId), next))
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
      {failed ? <Problem text={t("mobile.connectors.levelFailed", { name: agent?.name ?? "" })} /> : null}
    </View>
  );
}

/** What always asks, whatever the level (deleting, publishing, answering customers). */
export function SafeNote() {
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

/** One dash per step, the ones done and the current in ink (`step`: "Passo 3 de 4: O que faz"). */
function Progress({ steps, step }: { steps: Step[]; step: Step }) {
  const { t } = useTranslation();
  const c = useColors();
  const index = steps.indexOf(step);
  return (
    <View
      style={styles.progress}
      accessible
      accessibilityLabel={t("mobile.connectors.step", {
        n: index + 1,
        total: steps.length,
        label: t(STEP_KEYS[step]),
      })}
    >
      {steps.map((s, i) => (
        <View key={s} style={[styles.dash, { backgroundColor: i <= index ? c.ink : c.line2 }]} />
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
    ...fieldText("body"),
  },
  keyRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  paste: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  note: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  // A neutral card with a colored badge: the outcome of connecting (`Problem` draws what went wrong the same).
  notice: {
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  badge: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  agents: { gap: 10 },
  agent: { gap: 10, padding: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  everyone: { borderWidth: 1 },
  agentHead: { flexDirection: "row", alignItems: "center", gap: 10 },
});
