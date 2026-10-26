import { useCredentials, useIssues, useMe } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import Constants from "expo-constants";
import { router } from "expo-router";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Image, Pressable, StyleSheet, View } from "react-native";
import Animated, { SlideInLeft, SlideInRight } from "react-native-reanimated";
import { signOut } from "@/features/account";
import { appHeaders, lastCookie } from "@/lib/auth";
import { photoSource } from "@/lib/photo";
import { pushPermission, registerForPush, unregisterPush } from "@/lib/push";
import { serverUrl } from "@/lib/server";
import { readValue, STORED } from "@/lib/storage";
import { useOrg } from "@/providers/org";
import {
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Icon,
  PersonAvatar,
  Text,
  type ThemePreference,
  useTheme,
  useToast,
} from "@/ui";
import { useColors, useDirectory, useMeId } from "../shared/hooks";
import { usePersonPhoto } from "../shared/photo";
import { AccountPage, ZonePage } from "./AccountPage";
import { type AccountDraft, openIssuesWithMe } from "./logic";
import { Page } from "./parts";

/** The screens inside the sheet (its own stack: tap a row, the next one slides in; back slides it out). */
export type MePage = "root" | "account" | "zone" | "workspaces" | "notifications" | "appearance" | "language";

/** Close the sheet, then open a pushed screen (the sheet's dismissal has to finish first). */
const closeThenPush = (onClose: () => void, href: string) => {
  onClose();
  setTimeout(() => router.push(href as never), 420);
};

/**
 * Você: a short settings list as on the iPhone. Your row opens Conta; the
 * workspace row opens Workspaces; "Do workspace" links Issues and Drive; Notificações, Aparência and
 * Idioma each open their own screen; then Sair and the app's version. A native form sheet over whatever
 * was on screen, with its own small stack.
 */
export function MeSheet({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const me = useMe();
  const meId = useMeId();
  const org = useOrg();
  const theme = useTheme();
  const toast = useToast();
  const dir = useDirectory();
  const issues = useIssues(org.orgId);
  const admin = can(org.org?.role, "manage_credentials");
  const credentials = useCredentials(org.orgId, admin);
  const liveKeys = (credentials.data ?? []).filter((k) => !k.revokedAt).length;
  const [stack, setStack] = useState<MePage[]>(["root"]);
  const [forward, setForward] = useState(true);
  const [push, setPush] = useState<boolean | null>(null);
  const [draft, setDraft] = useState<AccountDraft | null>(null);
  const page = stack[stack.length - 1] ?? "root";
  const go = (next: MePage) => {
    setForward(true);
    setStack((s) => [...s, next]);
  };
  const back = () => {
    setForward(false);
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  };

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

  const mine = meId ? dir.memberById.get(meId) : undefined;
  const name = me.data?.user.name ?? "";
  const photo = usePersonPhoto(mine?.avatarUrl ?? mine?.image ?? me.data?.user.image);
  const role = org.org ? t(`mobile.me.role.${org.org.role}`) : "";
  const themeLabel = t(`mobile.theme.${theme.preference}`);
  const en = i18n.language.startsWith("en");
  const withMe = openIssuesWithMe(issues.data, meId);
  const version = Constants.expoConfig?.version ?? "";

  const openAccount = () => {
    setDraft({ name, handle: mine?.handle ?? "", zone: mine?.timezone ?? null });
    go("account");
  };

  let body: ReactNode;
  switch (page) {
    case "account":
      body = draft ? (
        <AccountPage
          draft={draft}
          setDraft={setDraft}
          onBack={back}
          onZone={() => go("zone")}
          onDelete={() => closeThenPush(onClose, "/account-delete")}
        />
      ) : null;
      break;
    case "zone":
      body = draft ? (
        <ZonePage
          value={draft.zone}
          onBack={back}
          onPick={(zone) => {
            setDraft({ ...draft, zone });
            back();
          }}
        />
      ) : null;
      break;
    case "workspaces":
      body = (
        <Page title={t("mobile.me.workspaces")} onBack={back}>
          <GroupedHeader>{t("mobile.me.workspacesIn")}</GroupedHeader>
          <GroupedList>
            {org.orgs.map((o) => (
              <GroupedRow
                key={o.id}
                leading={<OrgTile name={o.name} logo={o.logo} />}
                label={o.name}
                checked={o.id === org.orgId}
                onPress={() => {
                  if (o.id === org.orgId) return;
                  org.setOrgId(o.id);
                  onClose();
                  router.replace("/");
                }}
              />
            ))}
          </GroupedList>
        </Page>
      );
      break;
    case "notifications":
      body = (
        <Page title={t("mobile.me.notifications")} onBack={back}>
          <View style={styles.gap} />
          <GroupedList>
            <GroupedRow
              label={t("mobile.me.notificationsPhone")}
              toggle={push ?? false}
              onPress={() => void setNotifications(!(push ?? false))}
            />
          </GroupedList>
          <GroupedFooter>{t("mobile.me.notificationsHint")}</GroupedFooter>
        </Page>
      );
      break;
    case "appearance":
      body = (
        <Page title={t("mobile.me.appearance")} onBack={back}>
          <View style={styles.gap} />
          <GroupedList>
            {(["system", "light", "dark"] as const).map((key) => (
              <GroupedRow
                key={key}
                label={t(`mobile.theme.${key}`)}
                checked={theme.preference === key}
                onPress={() => theme.setPreference(key as ThemePreference)}
              />
            ))}
          </GroupedList>
        </Page>
      );
      break;
    case "language":
      body = (
        <Page title={t("mobile.me.language")} onBack={back}>
          <View style={styles.gap} />
          <GroupedList>
            <GroupedRow label={t("mobile.me.langPt")} checked={!en} onPress={() => void i18n.changeLanguage("pt-BR")} />
            <GroupedRow label={t("mobile.me.langEn")} checked={en} onPress={() => void i18n.changeLanguage("en")} />
          </GroupedList>
        </Page>
      );
      break;
    default:
      body = (
        <Page>
          <AccountCard
            name={name}
            sub={t("mobile.me.accountSub", { handle: mine?.handle ?? "" })}
            photo={<PersonAvatar name={name || "?"} size={56} photo={photo} />}
            onPress={openAccount}
          />
          <View style={styles.gap} />
          <GroupedList>
            <GroupedRow
              leading={<OrgTile name={org.org?.name ?? ""} logo={org.org?.logo} />}
              label={org.org?.name ?? ""}
              sub={t("mobile.me.workspaceSub", { role, count: org.orgs.length })}
              value={org.orgs.length > 1 ? t("mobile.me.switchOrg") : undefined}
              chevron
              onPress={() => go("workspaces")}
            />
          </GroupedList>
          <GroupedHeader>{t("mobile.me.fromWorkspace")}</GroupedHeader>
          <GroupedList>
            <GroupedRow
              icon="checkc"
              label={t("mobile.me.issues")}
              value={withMe > 0 ? t("mobile.me.issuesWithMe", { count: withMe }) : undefined}
              chevron
              onPress={() => closeThenPush(onClose, "/issues")}
            />
            <GroupedRow
              icon="doc"
              label={t("mobile.me.drive")}
              chevron
              onPress={() => closeThenPush(onClose, "/drive")}
            />
            <GroupedRow
              icon="bolt"
              label={t("mobile.me.connectors")}
              chevron
              onPress={() => closeThenPush(onClose, "/connectors")}
            />
            <GroupedRow
              icon="chart"
              label={t("mobile.me.usage")}
              chevron
              onPress={() => closeThenPush(onClose, "/usage")}
            />
            <GroupedRow
              icon="brain"
              label={t("mobile.ai.row")}
              value={
                admin && credentials.data
                  ? liveKeys > 0
                    ? t("mobile.ai.rowKeys", { count: liveKeys })
                    : t("mobile.ai.rowNone")
                  : undefined
              }
              chevron
              onPress={() => closeThenPush(onClose, "/ai-accounts")}
            />
          </GroupedList>
          <GroupedHeader>{t("mobile.me.preferences")}</GroupedHeader>
          <GroupedList>
            <GroupedRow
              icon="bell"
              label={t("mobile.me.notifications")}
              value={push === null ? undefined : push ? t("mobile.me.on") : t("mobile.me.off")}
              chevron
              onPress={() => go("notifications")}
            />
            <GroupedRow
              icon={theme.scheme === "dark" ? "moon" : "sun"}
              label={t("mobile.me.appearance")}
              value={themeLabel}
              chevron
              onPress={() => go("appearance")}
            />
            <GroupedRow
              icon="globe"
              label={t("mobile.me.language")}
              value={en ? t("mobile.me.langEn") : t("mobile.me.langPt")}
              chevron
              onPress={() => go("language")}
            />
          </GroupedList>
          <View style={styles.gapBig} />
          <GroupedList>
            <GroupedRow
              icon="out"
              label={t("mobile.me.signOut")}
              onPress={() =>
                Alert.alert(t("mobile.me.signOutConfirm"), t("mobile.me.signOutConfirmText"), [
                  { text: t("mobile.common.cancel"), style: "cancel" },
                  {
                    text: t("mobile.me.signOut"),
                    style: "destructive",
                    onPress: () => {
                      onClose();
                      void signOut();
                    },
                  },
                ])
              }
            />
          </GroupedList>
          {version ? <GroupedFooter>{t("mobile.me.version", { version })}</GroupedFooter> : null}
        </Page>
      );
  }

  return (
    <Animated.View
      key={`${stack.length}-${page}`}
      entering={
        theme.reducedMotion || (stack.length === 1 && forward)
          ? undefined
          : forward
            ? SlideInRight.duration(260)
            : SlideInLeft.duration(260)
      }
      style={styles.fill}
    >
      {body}
    </Animated.View>
  );
}

/** Your row at the top: photo, name, "@handle · foto, nome e conta" and a chevron. */
function AccountCard({
  name,
  sub,
  photo,
  onPress,
}: {
  name: string;
  sub: string;
  photo: ReactNode;
  onPress: () => void;
}) {
  const { colors: c, shadows } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${sub}`}
      style={({ pressed }) => [
        styles.acc,
        { backgroundColor: pressed ? c.sunken : c.raised, boxShadow: `${shadows.e1}, ${shadows.top}` },
      ]}
    >
      {photo}
      <View style={styles.grow}>
        <Text variant="title" numberOfLines={1} style={styles.accName}>
          {name}
        </Text>
        <Text variant="small" tone="muted" numberOfLines={1}>
          {sub}
        </Text>
      </View>
      <Icon name="right" size={15} color={c.faint} />
    </Pressable>
  );
}

/** A workspace: its logo, or its initial on a neutral tile. */
function OrgTile({ name, logo }: { name: string; logo?: string | null | undefined }) {
  const c = useColors();
  const source = photoSource(logo, serverUrl(), appHeaders(lastCookie()));
  if (source) return <Image source={source} style={styles.org} accessibilityIgnoresInvertColors />;
  return (
    <View style={[styles.org, { backgroundColor: c.ink2 }]}>
      <Text variant="label" style={{ color: c.bg }}>
        {(name.trim()[0] ?? "?").toLocaleUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flex: 1, minWidth: 0 },
  gap: { height: 14 },
  gapBig: { height: 22 },
  acc: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
  },
  accName: { fontSize: 18 },
  org: { width: 30, height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center" },
});
