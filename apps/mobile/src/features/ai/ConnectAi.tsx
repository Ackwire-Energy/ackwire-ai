import { type ConnectIntent, keys, useAiStatus, useApi } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { type AiChoice, aiStateOf, defaultChoice, firstAgent, gateDims } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import {
  keyLooksValid,
  type ProviderId,
  providerGuess,
  providerLabel,
  providerOf,
} from "@agenteschat/client/lib/providers";
import { useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { serverUrl } from "@/lib/server";
import { useOrg } from "@/providers/org";
import { Button, SheetScreen } from "@/ui";
import { SheetHeader } from "../new/parts";
import { useDirectory, useMeId } from "../shared/hooks";
import { AiPicker, type KeyDraft, KeyPanel, PlanPanel, usePlanGates } from "./ConnectAiSteps";
import { openPage } from "./parts";

/**
 * The first run's API key (the web's key panel, saved by the step's button): a pay-as-you-go key for the
 * workspace. Agents without a key of their own think with the newest one of their provider, so nothing else needs
 * pointing. `orgId` is passed in: the first run goes before a workspace is chosen.
 */
export function useConnectKey(orgId: string, asked?: string) {
  const api = useApi();
  const qc = useQueryClient();
  const [provider, setProvider] = useState<ProviderId>(() => providerGuess(undefined, asked));
  const [key, setKeyRaw] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const clean = key.trim();
  const looksRight = clean.length === 0 || keyLooksValid(provider, clean);
  // A pasted key says whose it is when only one provider's keys look like it.
  const setKey = (value: string) => {
    setKeyRaw(value);
    setFailed(false);
    if (value.trim().length > 12) setProvider(providerGuess(value, provider));
  };
  const save = async (): Promise<boolean> => {
    if (!clean || saving) return false;
    setSaving(true);
    setFailed(false);
    try {
      const entry = providerOf(provider);
      await api.agents.addCredential(orgId, { provider, label: entry?.label ?? provider, apiKey: clean });
      // `aiStatus` lives under `credentials`: both refresh.
      await qc.invalidateQueries({ queryKey: keys.credentials(orgId) });
      return true;
    } catch {
      setFailed(true);
      return false;
    } finally {
      setSaving(false);
    }
  };
  return { provider, setProvider, key, setKey, looksRight, ready: clean.length > 0, saving, failed, save };
}

export type ConnectKey = ReturnType<typeof useConnectKey>;

/**
 * "Conectar uma IA" as a sheet, as the web's dialog (ADR 0061): the plans first (Claude chosen), each signing in
 * on the agent's computer, then the workspace's API key; a message that asked for one of them opens on it
 * (`/connect-ai?from=<messageId>&intent=<step>&provider=<id>&agentId=<id>`). Once connected from a message, the
 * agent answers it by itself.
 */
export function ConnectAiSheet() {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const { orgId, org } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const status = useAiStatus(orgId);
  const params = useLocalSearchParams<{ from?: string; provider?: string; agentId?: string; intent?: string }>();
  // An API key is the organization's (admins); a plan thinks only for its owner's agents (ADR 0059 §3).
  const mayAddKey = can(org?.role, "manage_credentials");
  const mine = dir.agents.filter((a) => a.ownerUserId === meId);
  const named = params.agentId ? [params.agentId] : null;
  const agents = (named ? mine.filter((a) => named.includes(a.id)) : mine).map((a) => ({ id: a.id, name: a.name }));
  // The agents a plan was connected for here: they think with it before the AI status says so.
  const [linked, setLinked] = useState<string[]>([]);
  const hasAi = (id: string) => linked.includes(id) || (aiStateOf(status.data, id) ?? "no_ai") !== "no_ai";
  const [pickedAgent, setPickedAgent] = useState<string>();
  const agentId = pickedAgent ?? firstAgent(agents, hasAi, params.agentId)?.id;
  const gates = usePlanGates(orgId, agentId);
  const [picked, setPicked] = useState<AiChoice | null>(null);
  const choice =
    picked ??
    defaultChoice({
      intent: params.intent as ConnectIntent | undefined,
      ownsAgents: agents.length > 0,
      mayAddKey,
      claudeGate: agentId ? gates.gateOf("claude") : { state: "loading" },
    });
  const [draft, setDraft] = useState<KeyDraft>(() => ({
    provider: providerGuess(undefined, params.provider),
    apiKey: "",
  }));
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [connected, setConnected] = useState(false);
  const [keySaved, setKeySaved] = useState(false);
  const done = () => {
    setConnected(true);
    void qc.invalidateQueries({ queryKey: keys.aiStatus(orgId) });
    if (params.from) void api.chat.answerNow(orgId, params.from).catch(() => undefined);
  };
  const saveKey = async () => {
    if (saving) return;
    setSaving(true);
    setFailed(false);
    try {
      await api.agents.addCredential(orgId, {
        provider: draft.provider,
        label: providerLabel(draft.provider),
        apiKey: draft.apiKey.trim(),
      });
      // `aiStatus` lives under `credentials`: both refresh.
      await qc.invalidateQueries({ queryKey: keys.credentials(orgId) });
      setKeySaved(true);
      done();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };
  // Opened for one agent: its name in the title.
  const one = named?.length === 1 ? dir.agentById.get(named[0] ?? "") : undefined;
  // No agent of theirs among those: who connects a plan instead.
  const owner = one?.ownerUserId ? dir.memberById.get(one.ownerUserId)?.name : undefined;
  const locked =
    agents.length > 0
      ? undefined
      : !named
        ? t("connectAi.noAgents")
        : one && owner
          ? t("noAi.locked", { name: one.name, owner: owner.split(" ")[0] })
          : t("noAi.lockedAdmins");
  return (
    <SheetScreen>
      <SheetHeader title={one ? t("connectAi.titleFor", agentGrammar(t, one.name)) : t("connectAi.title.any")} />
      {dir.loading || status.isPending ? (
        <ActivityIndicator style={styles.loading} />
      ) : (
        <View style={styles.body}>
          <AiPicker
            choice={choice}
            onPick={(next) => {
              setPicked(next);
              // Another plan moves on to the next agent with no AI once this one thinks with a plan from here.
              if (next !== "key" && next !== choice && agentId !== undefined && linked.includes(agentId))
                setPickedAgent(firstAgent(agents, hasAi)?.id);
            }}
            dims={(c) => agentId !== undefined && gateDims(gates.gateOf(c))}
          />
          {choice === "key" ? (
            <KeyPanel
              draft={draft}
              onDraft={(d) => {
                setDraft(d);
                setFailed(false);
              }}
              locked={!mayAddKey}
              saved={keySaved}
              saving={saving}
              failed={failed}
              onSave={() => void saveKey()}
            />
          ) : (
            <PlanPanel
              key={choice}
              choice={choice}
              gates={gates}
              agents={agents}
              agentId={agentId}
              onAgent={setPickedAgent}
              locked={locked}
              onKey={() => setPicked("key")}
              onComputer={() => openPage(`${serverUrl()}/org/${orgId}/settings/computers`)}
              onDone={(id) => {
                // The panel stays on that agent, saying it's done.
                setPickedAgent(id);
                setLinked((l) => [...l, id]);
                done();
              }}
            />
          )}
          {connected ? (
            <Button
              variant="primary"
              wide
              label={t("connectAi.done")}
              onPress={() => {
                if (router.canGoBack()) router.back();
              }}
            />
          ) : null}
        </View>
      )}
    </SheetScreen>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 24 },
  body: { gap: 16 },
});
