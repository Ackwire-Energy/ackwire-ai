import { type ConnectIntent, keys, useAiAccounts, useAiStatus, useApi } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { aiStateOf, choiceOfIntent, freePlanAccount, PLAN_CHOICES } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { keyLooksValid, type ProviderId, providerGuess, providerOf } from "@agenteschat/client/lib/providers";
import { useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { serverUrl } from "@/lib/server";
import { useOrg } from "@/providers/org";
import { Button, SheetScreen } from "@/ui";
import { useDirectory, useMeId } from "../shared/hooks";
import { ConnectAiFlow, type FlowView, viewOf } from "./ConnectAiSteps";
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
 * "Conectar uma IA" as a sheet (`/connect-ai?from=<messageId>&intent=<step>&provider=<id>&agentId=<id>&plan=<plan>
 * &email=<address>&ready=1&forNew=1`): for an agent with no AI what the person already has, then the plans, each signing in on
 * the agent's computer, then the workspace's API key (ConnectAiFlow); a message that asked for one of them opens on
 * its page, and `plan` on that plan's (Sign in again).
 * Once connected from a message, the agent answers it by itself. `email`: one more login of the account other agents
 * use. `ready`: opened because the workspace's computer just got ready (its notification): a plan's page says so.
 */
export function ConnectAiSheet() {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const { orgId, org } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const status = useAiStatus(orgId);
  const params = useLocalSearchParams<{
    from?: string;
    provider?: string;
    agentId?: string;
    intent?: string;
    plan?: string;
    email?: string;
    ready?: string;
    forNew?: string;
  }>();
  // An API key is the organization's (admins); a plan thinks only for its owner's agents (ADR 0059 §3).
  const mayAddKey = can(org, "manage_credentials");
  // From the create-agent step: for the agent being made, never one I have.
  const mine = params.forNew === "1" ? [] : dir.agents.filter((a) => a.ownerUserId === meId);
  const named = params.agentId ? [params.agentId] : null;
  const agents = (named ? mine.filter((a) => named.includes(a.id)) : mine).map((a) => ({ id: a.id, name: a.name }));
  // The agents a plan was connected for here: they think with it before the AI status says so.
  const [linked, setLinked] = useState<string[]>([]);
  const hasAi = (id: string) => linked.includes(id) || (aiStateOf(status.data, id) ?? "no_ai") !== "no_ai";
  const [view, setView] = useState<FlowView>(() =>
    viewOf(PLAN_CHOICES.find((c) => c === params.plan) ?? choiceOfIntent(params.intent as ConnectIntent | undefined)),
  );
  const form = useConnectKey(orgId, params.provider);
  const [keySaved, setKeySaved] = useState(false);
  const answer = () => {
    void qc.invalidateQueries({ queryKey: keys.aiStatus(orgId) });
    if (params.from) void api.chat.answerNow(orgId, params.from).catch(() => undefined);
  };
  // Opened for one agent: its name in the title.
  const one = named?.length === 1 ? dir.agentById.get(named[0] ?? "") : undefined;
  // No agent of theirs yet, and it isn't opened for someone else's: a plan signs in for the agents they create.
  const bare = !named && agents.length === 0;
  const [accountAdded, setAccountAdded] = useState(false);
  // Or one of that plan they already have, which the plan's page says is connected.
  const ai = useAiAccounts(orgId, bare);
  const hasPlan = bare && view.page === "plan" && freePlanAccount(ai.data?.accounts, view.choice) !== undefined;
  // Someone else's agent: who connects a plan instead.
  const owner = one?.ownerUserId ? dir.memberById.get(one.ownerUserId)?.name : undefined;
  const locked =
    agents.length > 0 || bare
      ? undefined
      : one && owner
        ? t("noAi.locked", { name: one.name, owner: owner.split(" ")[0] })
        : t("noAi.lockedAdmins");
  const close = () => {
    if (router.canGoBack()) router.back();
  };
  return (
    <SheetScreen>
      {dir.loading || status.isPending ? (
        <ActivityIndicator style={styles.loading} />
      ) : (
        <ConnectAiFlow
          view={view}
          onView={setView}
          sheetTitle={one ? t("connectAi.titleFor", agentGrammar(one.name)) : t("connectAi.title.any")}
          agents={agents}
          hasAi={hasAi}
          {...(params.agentId ? { startAgentId: params.agentId } : {})}
          {...(params.email ? { email: params.email } : {})}
          locked={locked}
          bare={bare}
          onAccount={() => {
            setAccountAdded(true);
            void qc.invalidateQueries({ queryKey: keys.aiAccounts(orgId) });
            void qc.invalidateQueries({ queryKey: keys.brainMachines(orgId) });
            answer();
          }}
          {...(one && one.ownerUserId !== meId && mayAddKey ? { theirs: { id: one.id, name: one.name } } : {})}
          justReady={params.ready === "1"}
          mayAddKey={mayAddKey}
          keyForm={form}
          keySaved={keySaved}
          onSaveKey={() =>
            void form.save().then((ok) => {
              if (!ok) return;
              setKeySaved(true);
              answer();
            })
          }
          onComputer={() => openPage(`${serverUrl()}/org/${orgId}/settings/computers`)}
          onPlanDone={(id) => {
            setLinked((l) => [...l, id]);
            answer();
          }}
        />
      )}
      {keySaved || linked.length > 0 || accountAdded || hasPlan ? (
        <View style={styles.done}>
          <Button variant="primary" wide label={t("connectAi.done")} onPress={close} />
        </View>
      ) : null}
    </SheetScreen>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 24 },
  done: { marginTop: 8 },
});
