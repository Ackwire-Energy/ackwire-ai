import type { AiAccounts as AiAccountsView, Credential } from "@agenteschat/client";
import { keys, useAiAccounts, useApi, useCredentials, useSettings, useUpdateSettings } from "@agenteschat/client";
import { ownSignIns, planWordOf } from "@agenteschat/client/lib/ai-accounts";
import { relativeTime } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { isPlanId, planOf } from "@agenteschat/client/lib/plans";
import { providerLabel } from "@agenteschat/client/lib/providers";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActionSheetIOS, ActivityIndicator, Alert, Platform, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import { Button, Card, Chip, InfoHint, ProviderLogo, Row, Text, useToast } from "@/ui";
import { useColors } from "../shared/hooks";
import { PushedHeader } from "../shared/parts";
import { PlanMeter } from "../usage/parts";
import { AddAccount } from "./AddAccount";
import { openConnectAi } from "./NoAiCard";
import { Note } from "./parts";

/*
 * Contas de IA, as the web's Settings › Contas de IA (ADR 0059, ADR 0061): "Seus planos", first the sign-ins of the
 * computers the person connected ("Conta deste computador", the agents there think with them), then their own
 * accounts on every computer, each with its plan's meter and the agent it thinks for, renamed, signed in again (a new
 * key for a coding plan) or disconnected here; then the workspace's API keys (admins), the default one, a key
 * swapped or deleted. Connecting a new one is the same picker as everywhere ("Conectar uma IA").
 */

type Account = AiAccountsView["accounts"][number];

/** A choice in the system's action list (the web's row buttons). */
function choose(
  title: string,
  options: { label: string; destructive?: boolean; onPress: () => void }[],
  cancel: string,
) {
  if (Platform.OS === "ios") {
    const destructive = options.findIndex((o) => o.destructive);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        options: [...options.map((o) => o.label), cancel],
        cancelButtonIndex: options.length,
        ...(destructive >= 0 ? { destructiveButtonIndex: destructive } : {}),
      },
      (i) => options[i]?.onPress(),
    );
  } else {
    Alert.alert(title, undefined, [
      ...options.map((o) => ({
        text: o.label,
        style: o.destructive ? ("destructive" as const) : undefined,
        onPress: o.onPress,
      })),
      { text: cancel, style: "cancel" as const },
    ]);
  }
}

export function AiAccountsScreen() {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const ai = useAiAccounts(orgId);
  const [again, setAgain] = useState<Account | null>(null);
  // Looking at the plans: their usage is looked up again (it comes back as `machine.updated`).
  useEffect(() => {
    void api.machines.refreshAccountUsage(orgId).catch(() => undefined);
  }, [api, orgId]);
  const rows = ai.data?.accounts ?? [];
  const own = ownSignIns(ai.data);
  const several = new Set(rows.map((r) => r.machineId)).size > 1;
  const refetch = () => void qc.invalidateQueries({ queryKey: keys.aiAccounts(orgId) });
  const failed = () => toast({ title: t("agentPage.work.failed"), icon: "x" });

  const rename = (a: Account) => {
    if (Platform.OS !== "ios") return;
    Alert.prompt(
      t("aiAccounts.page.renameTitle", { label: a.label }),
      t("aiAccounts.done.name"),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("common.save"),
          onPress: (value?: string) => {
            const name = (value ?? "").trim().slice(0, 40);
            if (!name || name === a.label) return;
            api.machines.renameAccount(orgId, a.machineId, a.id, name).then(() => {
              toast({ title: t("aiAccounts.page.renamed", { label: name }), icon: "check" });
              refetch();
            }, failed);
          },
        },
      ],
      "plain-text",
      a.label,
    );
  };
  const remove = (a: Account) =>
    Alert.alert(
      t("aiAccounts.page.disconnectTitle", { label: a.label }),
      a.usedBy[0]
        ? t("aiAccounts.page.disconnectAgent", { agent: a.usedBy[0], computer: a.computer })
        : t("aiAccounts.page.disconnectNone", { computer: a.computer }),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("aiAccounts.page.disconnect"),
          style: "destructive",
          onPress: () =>
            api.machines.removeAccount(orgId, a.machineId, a.id).then(() => {
              toast({ title: t("aiAccounts.page.disconnected", { label: a.label }), icon: "check" });
              refetch();
              void qc.invalidateQueries({ queryKey: keys.agents(orgId) });
            }, failed),
        },
      ],
    );
  const actions = (a: Account) => {
    const plan = planOf(a.provider);
    const out = a.status === "signed_out";
    choose(
      a.label,
      [
        ...(Platform.OS === "ios" ? [{ label: t("aiAccounts.page.rename"), onPress: () => rename(a) }] : []),
        ...(out || plan
          ? [
              {
                label: plan ? t("aiAccounts.page.newKey") : t("aiAccounts.page.signInAgain"),
                onPress: () => setAgain(a),
              },
            ]
          : []),
        { label: t("aiAccounts.page.disconnect"), destructive: true, onPress: () => remove(a) },
      ],
      t("common.cancel"),
    );
  };

  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={t("mobile.ai.row")} solid={false} grouped />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.in, { paddingBottom: insets.bottom + 24 }]}
      >
        <View style={styles.sectionHead}>
          <InfoHint
            name={t("common.about", { label: t("aiAccounts.page.title") })}
            text={t("aiAccounts.page.hint")}
            variant="title"
          >
            <Text variant="title" tone="ink">
              {t("aiAccounts.page.title")}
            </Text>
          </InfoHint>
        </View>
        {ai.isLoading ? <ActivityIndicator color={c.muted} /> : null}
        {ai.isError ? <Note icon="x">{t("common.loadFailed")}</Note> : null}
        {ai.isSuccess && rows.length === 0 && own.length === 0 ? (
          <Text variant="small" tone="muted">
            {t("aiAccounts.page.empty")}
          </Text>
        ) : null}
        {own.length > 0 ? (
          <Card>
            {own.map((o) => (
              <Row
                key={o.key}
                leading={<ProviderLogo id={o.kind} size="sm" />}
                title={[t(`aiAccounts.connect.${o.kind}`), planWordOf(o.plan)].filter(Boolean).join(" ")}
                subtitle={t("aiAccounts.page.ownOn", { computer: o.computer })}
                below={
                  o.usage ? (
                    <View style={styles.below}>
                      <PlanMeter usage={o.usage} compact />
                    </View>
                  ) : undefined
                }
              />
            ))}
          </Card>
        ) : null}
        {rows.length > 0 ? (
          <Card>
            {rows.map((a) => {
              const plan = planOf(a.provider);
              const out = a.status === "signed_out";
              const facts = [
                a.email ?? (a.keyHint ? t("aiAccounts.page.keyEnds", { hint: a.keyHint }) : null),
                several ? t("aiAccounts.page.on", { computer: a.computer }) : null,
                a.usedBy[0] ? t("aiAccounts.page.thinksFor", { agent: a.usedBy[0] }) : t("aiAccounts.page.noAgent"),
              ].filter(Boolean);
              return (
                <Row
                  key={a.id}
                  leading={<ProviderLogo id={a.provider ?? a.kind} size="sm" off={out} />}
                  title={a.label}
                  subtitle={facts.join(" · ")}
                  chevron
                  onPress={() => actions(a)}
                  below={
                    out || a.usage || (plan && !plan.usage) ? (
                      <View style={styles.below}>
                        {out ? (
                          <Note icon="x">
                            {plan ? t("aiAccounts.page.keyRefused") : t("aiAccounts.page.signedOut")}
                          </Note>
                        ) : null}
                        {a.usage ? (
                          <PlanMeter usage={a.usage} compact />
                        ) : plan && !plan.usage ? (
                          <Text variant="small" tone="muted">
                            {t("aiAccounts.usage.notShared", { maker: plan.maker })}
                          </Text>
                        ) : null}
                      </View>
                    ) : undefined
                  }
                />
              );
            })}
          </Card>
        ) : null}
        {again ? (
          <Card>
            <View style={styles.again}>
              <View style={styles.againHead}>
                <Text variant="callout" tone="ink" style={[styles.bold, styles.grow]}>
                  {again.label}
                </Text>
                <Button size="sm" variant="ghost" label={t("common.back")} onPress={() => setAgain(null)} />
              </View>
              <AddAccount
                machineId={again.machineId}
                kind={again.kind}
                computer={again.computer}
                again={again.id}
                email={again.email}
                local={ai.data?.computers.find((x) => x.machineId === again.machineId)?.mine}
                {...(isPlanId(again.provider) ? { provider: again.provider } : {})}
                onAdded={() => {
                  setAgain(null);
                  refetch();
                }}
              />
            </View>
          </Card>
        ) : null}
        <View style={styles.start}>
          <Button
            size="sm"
            variant={rows.length || own.length ? "secondary" : "primary"}
            icon="plus"
            label={t("aiAccounts.page.connect")}
            onPress={() => openConnectAi()}
          />
        </View>
        {can(org, "manage_credentials") ? <KeysSection locale={i18n.language} /> : null}
      </ScrollView>
    </View>
  );
}

/** The workspace's API keys (the web's "Chaves de provedor"): the default one, a key swapped or deleted. */
function KeysSection({ locale }: { locale: string }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const c = useColors();
  const credentials = useCredentials(orgId);
  const settings = useSettings(orgId);
  const update = useUpdateSettings(orgId);
  const live = (credentials.data ?? []).filter((k) => !k.revokedAt);
  const refetch = () => void qc.invalidateQueries({ queryKey: keys.credentials(orgId) });
  const failed = () => toast({ title: t("agentPage.work.failed"), icon: "x" });

  const rotate = (k: Credential) => {
    if (Platform.OS !== "ios") return;
    Alert.prompt(
      t("settings.rotateTitle", { label: k.label }),
      t("settings.rotateHelp"),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("settings.saveKey"),
          onPress: (value?: string) => {
            const apiKey = (value ?? "").trim();
            if (apiKey.length < 8) return;
            api.agents.rotateCredential(orgId, k.id, { apiKey }).then(() => {
              toast({ title: t("settings.rotated"), icon: "check" });
              refetch();
            }, failed);
          },
        },
      ],
      "secure-text",
    );
  };
  const remove = (k: Credential) =>
    Alert.alert(t("settings.removeTitle", { label: k.label }), t("settings.removeText"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("settings.remove"),
        style: "destructive",
        onPress: () => api.agents.removeCredential(orgId, k.id, true).then(refetch, failed),
      },
    ]);
  const actions = (k: Credential, isDefault: boolean) =>
    choose(
      k.label,
      [
        ...(isDefault
          ? []
          : [{ label: t("settings.makeDefault"), onPress: () => update.mutate({ defaultCredentialId: k.id }) }]),
        ...(Platform.OS === "ios" ? [{ label: t("settings.rotate"), onPress: () => rotate(k) }] : []),
        ...(isDefault ? [] : [{ label: t("settings.remove"), destructive: true, onPress: () => remove(k) }]),
      ],
      t("common.cancel"),
    );

  return (
    <>
      <View style={[styles.sectionHead, styles.keysHead]}>
        <Text variant="title" tone="ink">
          {t("settings.keysTitle")}
        </Text>
        <Text variant="small" tone="muted">
          {t("settings.keysSubtitle")}
        </Text>
      </View>
      {credentials.isLoading ? <ActivityIndicator color={c.muted} /> : null}
      {credentials.isSuccess && live.length === 0 ? (
        <Text variant="small" tone="muted">
          {t("settings.noKeys")}
        </Text>
      ) : null}
      {live.length > 0 ? (
        <Card>
          {live.map((k) => {
            const isDefault = settings.data?.defaultCredentialId === k.id;
            return (
              <Row
                key={k.id}
                leading={<ProviderLogo id={k.provider} size="sm" />}
                title={k.label}
                subtitle={`${providerLabel(k.provider)} · ${t("settings.keyEndsIn", { hint: k.keyHint })} · ${t("settings.keyAdded", { when: relativeTime(t, locale, k.createdAt) })}`}
                meta={isDefault ? <Chip icon="check" label={t("settings.default")} /> : undefined}
                chevron
                onPress={() => actions(k, isDefault)}
              />
            );
          })}
        </Card>
      ) : null}
      {live.some((k) => settings.data?.defaultCredentialId === k.id) ? (
        <Text variant="small" tone="faint">
          {t("settings.removeDefaultBlocked")}
        </Text>
      ) : null}
      <View style={styles.start}>
        <Button
          size="sm"
          variant="secondary"
          icon="plus"
          label={t("settings.addKey")}
          onPress={() => openConnectAi({ intent: "api_key" })}
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 18, paddingTop: 8, gap: 12 },
  sectionHead: { gap: 4, paddingHorizontal: 2 },
  keysHead: { marginTop: 18 },
  below: { gap: 8, marginTop: 6 },
  meter: { gap: 4 },
  meterLine: { flexDirection: "row", justifyContent: "space-between" },
  bar: { height: 6, borderRadius: 3, overflow: "hidden" },
  fill: { height: 6, borderRadius: 3 },
  bold: { fontWeight: "600" },
  grow: { flex: 1, minWidth: 0 },
  start: { alignSelf: "flex-start" },
  again: { padding: 14, gap: 12 },
  againHead: { flexDirection: "row", alignItems: "center", gap: 8 },
});
