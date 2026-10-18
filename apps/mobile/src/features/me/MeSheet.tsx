import { useMe } from "@agenteschat/client";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { signOut } from "@/features/account";
import { pushPermission, registerForPush, unregisterPush } from "@/lib/push";
import { readValue, STORED } from "@/lib/storage";
import { useOrg } from "@/providers/org";
import {
  Icon,
  PersonAvatar,
  Segmented,
  SheetScreen,
  Text,
  type ThemePreference,
  Toggle,
  useTheme,
  useToast,
} from "@/ui";
import { useColors } from "../shared/hooks";
import { ActionList } from "../shared/parts";
import { usePersonPhoto } from "../shared/photo";

/**
 * Você: who you are and where, switching organizations, Aparência, push,
 * Idioma, Sair and Apagar conta. A sheet over whatever was on screen.
 */
export function MeSheet({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const org = useOrg();
  const theme = useTheme();
  const c = useColors();
  const toast = useToast();
  const [push, setPush] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    void Promise.all([pushPermission(), readValue(STORED.pushToken)]).then(([permission, token]) => {
      if (alive) setPush(permission === "granted" && Boolean(token));
    });
    return () => {
      alive = false;
    };
  }, []);

  const setNotifications = async (on: boolean) => {
    setPush(on);
    if (on) {
      const ok = await registerForPush({ ask: true, locale: i18n.language });
      setPush(ok);
      if (!ok) toast({ title: t("mobile.me.pushOff"), subtitle: t("mobile.me.pushOffSub"), icon: "bell" });
    } else await unregisterPush();
  };

  const name = me.data?.user.name ?? "";
  const photo = usePersonPhoto(me.data?.user.image);
  const role = org.org ? t(`mobile.me.role.${org.org.role}`) : "";
  return (
    <SheetScreen>
      <View style={styles.in}>
        <View style={styles.head}>
          <PersonAvatar name={name || "?"} size={44} photo={photo} />
          <View style={styles.grow}>
            <Text variant="title">{name}</Text>
            <Text variant="small" tone="muted">
              {[org.org?.name, role].filter(Boolean).join(" · ")}
            </Text>
          </View>
        </View>

        {org.orgs.length > 1 ? (
          <ActionList
            items={org.orgs.map((o) => ({
              key: o.id,
              icon: "home" as const,
              label: o.name,
              trailing: o.id === org.orgId ? <Icon name="check" size={18} color={c.ink} /> : undefined,
              onPress: () => {
                if (o.id !== org.orgId) {
                  org.setOrgId(o.id);
                  onClose();
                  router.replace("/");
                }
              },
            }))}
          />
        ) : null}

        <View style={styles.block}>
          <View style={styles.label}>
            <Icon name={theme.scheme === "dark" ? "moon" : "sun"} size={18} color={c.muted} />
            <Text variant="body">{t("mobile.me.appearance")}</Text>
          </View>
          <Segmented
            items={[
              { key: "system", label: t("mobile.theme.system") },
              { key: "light", label: t("mobile.theme.light") },
              { key: "dark", label: t("mobile.theme.dark") },
            ]}
            value={theme.preference}
            onChange={(key) => theme.setPreference(key as ThemePreference)}
          />
        </View>

        <View style={styles.block}>
          <Toggle
            value={push ?? false}
            onChange={(on) => void setNotifications(on)}
            label={t("mobile.me.notifications")}
          />
          <Text variant="caption" tone="faint">
            {t("mobile.me.notificationsHint")}
          </Text>
        </View>

        <View style={styles.block}>
          <View style={styles.label}>
            <Icon name="globe" size={18} color={c.muted} />
            <Text variant="body">{t("mobile.me.language")}</Text>
          </View>
          <Segmented
            items={[
              { key: "pt-BR", label: t("mobile.me.langPt") },
              { key: "en", label: t("mobile.me.langEn") },
            ]}
            value={i18n.language.startsWith("en") ? "en" : "pt-BR"}
            onChange={(key) => void i18n.changeLanguage(key)}
          />
        </View>

        <ActionList
          items={[
            {
              key: "out",
              icon: "out",
              label: t("mobile.me.signOut"),
              danger: true,
              onPress: () => {
                onClose();
                void signOut();
              },
            },
            {
              key: "delete",
              icon: "x",
              label: t("mobile.me.deleteAccount"),
              hint: t("mobile.me.deleteAccountHint"),
              danger: true,
              onPress: () => {
                onClose();
                setTimeout(() => router.push("/account-delete"), 420);
              },
            },
          ]}
        />
      </View>
    </SheetScreen>
  );
}

const styles = StyleSheet.create({
  in: { gap: 12 },
  head: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 2 },
  grow: { flex: 1 },
  block: { gap: 8, paddingHorizontal: 4 },
  label: { flexDirection: "row", alignItems: "center", gap: 10 },
});
