import { keys, useApi, useCredentials } from "@agenteschat/client";
import { providerGrammar } from "@agenteschat/client/lib/grammar";
import { can } from "@agenteschat/client/lib/permissions";
import {
  keyLooksValid,
  PROVIDERS,
  type ProviderId,
  providerGuess,
  providerOf,
} from "@agenteschat/client/lib/providers";
import { useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { openBrowserAsync } from "expo-web-browser";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useOrg } from "@/providers/org";
import {
  Button,
  fieldText,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Icon,
  SheetScreen,
  Text,
  useTheme,
  useToast,
} from "@/ui";
import { ProviderLogo } from "@/ui/ProviderLogo";
import { SheetHeader } from "../new/parts";

/**
 * Connecting an AI from the phone (the web's "Chave de API" in Connect, ADR 0061): a pay-as-you-go key
 * for the workspace. Agents without a key of their own think with the newest one of their provider, so
 * nothing else needs pointing. Plans (Claude, ChatGPT, coding plans) sign in on a computer, so the phone
 * only says where. `orgId` is passed in: the onboarding runs before a workspace is chosen.
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

/** The provider, where to create its key, the field and what it does: the same order as the web's panel. */
export function KeyFields({
  form,
  gutter = 18,
}: {
  form: ConnectKey;
  /** The screen's side margin: the providers' row scrolls to the screen's edges past it. */
  gutter?: number;
}) {
  const { t } = useTranslation();
  const { colors: c, shadows } = useTheme();
  const entry = providerOf(form.provider);
  const grammar = providerGrammar(t, form.provider);
  return (
    <View style={styles.fields}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ marginHorizontal: -gutter }}
        contentContainerStyle={[styles.providers, { paddingHorizontal: gutter }]}
      >
        {PROVIDERS.map((p) => {
          const on = p.id === form.provider;
          return (
            <Pressable
              key={p.id}
              onPress={() => form.setProvider(p.id)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={p.label}
              style={[
                styles.provider,
                { backgroundColor: on ? c.ink : c.chip, borderColor: on ? c.ink : "transparent" },
              ]}
            >
              <ProviderLogo id={p.id} size="xs" />
              <Text variant="subhead" style={{ color: on ? c.bg : c.ink, fontWeight: "600" }}>
                {p.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      {entry ? (
        <Pressable
          onPress={() => void openBrowserAsync(`https://${entry.site}`).catch(() => undefined)}
          accessibilityRole="link"
          style={styles.create}
          hitSlop={6}
        >
          <Text variant="subhead" style={{ fontWeight: "600" }}>
            {t("connectAi.key.create", grammar)}
          </Text>
          <Icon name="out" size={15} color={c.muted} />
        </Pressable>
      ) : null}
      <TextInput
        value={form.key}
        onChangeText={form.setKey}
        placeholder={entry?.placeholder ?? t("connectAi.key.paste")}
        placeholderTextColor={c.faint}
        accessibilityLabel={t("mobile.ai.field")}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        secureTextEntry
        textContentType="none"
        style={[styles.input, { color: c.ink, backgroundColor: c.raised, boxShadow: `${shadows.e1}, ${shadows.top}` }]}
      />
      {form.failed ? (
        <Text variant="small" tone="danger" accessibilityLiveRegion="polite">
          {t("mobile.ai.failed")}
        </Text>
      ) : !form.looksRight ? (
        <Text variant="small" tone="danger" accessibilityLiveRegion="polite">
          {t("mobile.ai.doesntLook", grammar)}
        </Text>
      ) : (
        <Text variant="small" tone="muted">
          {entry && "plans" in entry && entry.plans ? t("connectAi.key.notPlan") : t("connectAi.key.forAll")}
        </Text>
      )}
      <Text variant="small" tone="faint">
        {t("mobile.ai.plans")}
      </Text>
    </View>
  );
}

/**
 * "Conectar uma IA" as a sheet (`/connect-ai?from=<messageId>&provider=<id>`): the workspace's keys and a
 * new one. With `from`, the agent that couldn't answer that message answers it once the key is saved.
 */
export function ConnectAiSheet() {
  const { t } = useTranslation();
  const api = useApi();
  const toast = useToast();
  const { orgId, org } = useOrg();
  const { from, provider } = useLocalSearchParams<{ from?: string; provider?: string }>();
  const admin = can(org?.role, "manage_credentials");
  const credentials = useCredentials(orgId, admin);
  const form = useConnectKey(orgId, provider);
  const live = (credentials.data ?? []).filter((k) => !k.revokedAt);
  const submit = async () => {
    if (!(await form.save())) return;
    toast({ title: t("connectAi.key.saved"), icon: "check" });
    if (from) await api.chat.answerNow(orgId, from).catch(() => undefined);
    if (router.canGoBack()) router.back();
  };
  return (
    <SheetScreen>
      <SheetHeader title={t("connectAi.title.any")} />
      {admin ? (
        <>
          {live.length > 0 ? (
            <>
              <GroupedHeader>{t("mobile.ai.saved")}</GroupedHeader>
              <GroupedList>
                {live.map((k) => (
                  <GroupedRow
                    key={k.id}
                    leading={<ProviderLogo id={k.provider} size="sm" />}
                    label={k.label}
                    sub={t("mobile.ai.endsIn", { hint: k.keyHint })}
                  />
                ))}
              </GroupedList>
              <GroupedHeader>{t("mobile.ai.another")}</GroupedHeader>
            </>
          ) : (
            <Text variant="callout" tone="muted" style={styles.lead}>
              {t("mobile.ai.lead")}
            </Text>
          )}
          <KeyFields form={form} />
          <Button
            variant="primary"
            wide
            label={form.saving ? t("mobile.ai.saving") : t("mobile.ai.save")}
            disabled={!form.ready || !form.looksRight || form.saving}
            onPress={() => void submit()}
          />
        </>
      ) : (
        <Text variant="callout" tone="muted" style={styles.lead}>
          {t("noAi.lockedAdmins")}
        </Text>
      )}
    </SheetScreen>
  );
}

const styles = StyleSheet.create({
  fields: { gap: 12 },
  providers: { gap: 8 },
  provider: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
  },
  create: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start" },
  input: { minHeight: 52, borderRadius: 15, paddingHorizontal: 16, paddingVertical: 12, ...fieldText("body") },
  lead: { marginHorizontal: 4 },
});
