import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { deleteAccount } from "@/features/account";
import { Card, HoldButton, Icon, Text, useToast } from "@/ui";
import { useColors } from "../shared/hooks";
import { PushedHeader } from "../shared/parts";
import { deleteBlockedText } from "./logic";

/**
 * Apagar conta (App Store 5.1.1(v)): what goes and what stays, then a hold.
 * Refused while you are the only owner of an organization with other people
 * (`sole_owner`): the screen says which ones and what to do.
 */
export function DeleteAccountScreen() {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const [blocked, setBlocked] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    const result = await deleteAccount();
    setBusy(false);
    // Deleted: the session ends and the gate shows sign-in.
    if (result.ok) toast({ title: t("mobile.account.deleted") });
    else if (result.reason === "sole_owner") setBlocked(result.organizations);
    else toast({ title: t("mobile.account.deleteFailed"), icon: "x" });
  };

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <PushedHeader title={t("mobile.me.deleteAccount")} solid={false} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.in, { paddingBottom: insets.bottom + 24 }]}
      >
        <Text variant="display">{t("mobile.delete.title")}</Text>
        <Text variant="body" tone="muted">
          {t("mobile.delete.intro")}
        </Text>
        <Card>
          <View style={styles.list}>
            {(["account", "orgs", "phones"] as const).map((k) => (
              <View key={k} style={styles.item}>
                <Icon name="x" size={16} color={c.muted} />
                <Text variant="small" tone="ink2" style={styles.grow}>
                  {t(`mobile.delete.goes.${k}`)}
                </Text>
              </View>
            ))}
            <View style={styles.item}>
              <Icon name="chat" size={16} color={c.muted} />
              <Text variant="small" tone="ink2" style={styles.grow}>
                {t("mobile.delete.stays")}
              </Text>
            </View>
          </View>
        </Card>
        {blocked ? (
          <Card>
            <View style={styles.list}>
              <Text variant="body" tone="danger">
                {deleteBlockedText(t, blocked)}
              </Text>
            </View>
          </Card>
        ) : null}
        <HoldButton
          label={t("mobile.delete.hold")}
          holdLabel={t("mobile.delete.holding")}
          onConfirm={() => void confirm()}
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 20, paddingTop: 8, gap: 16 },
  list: { padding: 14, gap: 10 },
  item: { flexDirection: "row", alignItems: "center", gap: 10 },
  grow: { flex: 1 },
});
