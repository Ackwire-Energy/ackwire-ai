import { type NoticeCategory, useApi, useNoticePrefs, useSetNoticePref } from "@agenteschat/client";
import { SOUND_STYLES, type SoundStyle } from "@agenteschat/ui/sfx";
import { useMutation } from "@tanstack/react-query";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { pushPermission, unregisterPush } from "@/lib/push";
import { setSoundChoice, useSoundChoice } from "@/lib/sounds";
import { readValue, STORED } from "@/lib/storage";
import { useOrg } from "@/providers/org";
import { usePush } from "@/providers/push";
import {
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  type IconName,
  type ThemePreference,
  useTheme,
  useToast,
} from "@/ui";
import { OrgAvatar } from "../shared/OrgAvatar";
import { Page } from "./parts";

/** Você's smaller screens, each pushed from its row: Workspaces, Notificações, Sons, Aparência and Idioma. */

const SOUND_LABELS: Record<SoundStyle, string> = {
  tactile: "mobile.me.soundTactile",
  sky: "mobile.me.soundSky",
  pixel: "mobile.me.soundPixel",
};

/** A sound style's name ("Tato"). */
export function useSoundLabel() {
  const { t } = useTranslation();
  return (style: SoundStyle) => t(SOUND_LABELS[style]);
}

/**
 * The phone's notifications as Você shows them: on when allowed and registered (read again each time the screen
 * shows, so the row is right after Notificações), and the switch.
 */
export function usePushSwitch() {
  const { t } = useTranslation();
  const toast = useToast();
  const { ask } = usePush();
  const [on, setOn] = useState<boolean | null>(null);
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void Promise.all([pushPermission(), readValue(STORED.pushToken)]).then(([permission, token]) => {
        if (alive) setOn(permission === "granted" && Boolean(token));
      });
      return () => {
        alive = false;
      };
    }, []),
  );
  const set = async (next: boolean) => {
    setOn(next);
    if (next) {
      // Through the provider, so Conversas knows the phone was asked (our sheet won't open after this).
      const ok = await ask();
      setOn(ok);
      if (!ok) toast({ title: t("mobile.me.pushOff"), subtitle: t("mobile.me.pushOffSub"), icon: "bell" });
    } else await unregisterPush();
  };
  return { on, set };
}

/** Workspaces: the ones you are in; another one switches to it and goes home. */
export function WorkspacesPage() {
  const { t } = useTranslation();
  const org = useOrg();
  return (
    <Page title={t("mobile.me.workspaces")}>
      <GroupedHeader>{t("mobile.me.workspacesIn")}</GroupedHeader>
      <GroupedList>
        {org.orgs.map((o) => (
          <GroupedRow
            key={o.id}
            leading={<OrgAvatar logo={o.logo} />}
            label={o.name}
            checked={o.id === org.orgId}
            onPress={() => {
              if (o.id === org.orgId) return;
              org.setOrgId(o.id);
              router.dismissTo("/");
            }}
          />
        ))}
      </GroupedList>
    </Page>
  );
}

const NOTICE_ICONS: Record<NoticeCategory, IconName> = {
  waiting: "wait",
  replies: "reply",
  mentions: "chat",
  threads: "replyTo",
  tasks: "issue",
  routines: "clock",
  computers: "laptop",
  reactions: "smile",
};

/**
 * Notificações: this phone's switch, then what notifies me in this workspace (ADR 0071 §8), the same choices as
 * the web's Configurações › Notificações (kept on the server, for every device). Off on this phone, the kinds stay,
 * dimmed: they still decide the browser and the Mac app.
 */
export function NotificationsPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const { orgId } = useOrg();
  const push = usePushSwitch();
  const prefs = useNoticePrefs(orgId);
  const set = useSetNoticePref(orgId);
  const on = push.on ?? false;
  return (
    <Page title={t("mobile.me.notifications")}>
      <View style={styles.gap} />
      <GroupedList>
        <GroupedRow label={t("mobile.me.notificationsPhone")} toggle={on} onPress={() => void push.set(!on)} />
      </GroupedList>
      <GroupedFooter>{on ? t("mobile.me.notificationsOnHint") : t("mobile.me.notificationsOffHint")}</GroupedFooter>
      {prefs.data ? (
        <>
          <GroupedHeader>{t("noticePrefs.whatTitle")}</GroupedHeader>
          <View style={on ? null : styles.dimmed}>
            <GroupedList>
              {prefs.data.categories.map((c) => (
                <GroupedRow
                  key={c.id}
                  icon={NOTICE_ICONS[c.id]}
                  label={t(`noticePrefs.category.${c.id}.title`)}
                  sub={t(`noticePrefs.category.${c.id}.help`)}
                  subLines={2}
                  toggle={c.on}
                  onPress={() =>
                    set.mutate(
                      { category: c.id, on: !c.on },
                      { onError: () => toast({ title: t("noticePrefs.failed"), icon: "x" }) },
                    )
                  }
                />
              ))}
            </GroupedList>
          </View>
          <GroupedFooter>{t("mobile.me.notificationsKindsHint")}</GroupedFooter>
        </>
      ) : null}
    </Page>
  );
}

/** Sons: on or off, then the style. */
export function SoundsPage() {
  const { t } = useTranslation();
  const sounds = useSoundChoice();
  const label = useSoundLabel();
  return (
    <Page title={t("mobile.me.sounds")}>
      <View style={styles.gap} />
      <GroupedList>
        <GroupedRow
          label={t("mobile.me.soundsOn")}
          toggle={sounds !== "off"}
          onPress={() => setSoundChoice(sounds === "off" ? "tactile" : "off")}
        />
      </GroupedList>
      <GroupedFooter>{t("mobile.me.soundsHint")}</GroupedFooter>
      {sounds !== "off" && (
        <>
          <GroupedHeader>{t("mobile.me.soundStyle")}</GroupedHeader>
          <GroupedList>
            {SOUND_STYLES.map((style) => (
              <GroupedRow
                key={style}
                label={label(style)}
                checked={sounds === style}
                onPress={() => setSoundChoice(style)}
              />
            ))}
          </GroupedList>
        </>
      )}
    </Page>
  );
}

/** Aparência: the system's, light or dark. */
export function AppearancePage() {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <Page title={t("mobile.me.appearance")}>
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
}

/** Idioma: Português or English. */
export function LanguagePage() {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const language = useMutation({
    mutationFn: (locale: "pt-BR" | "en") => api.account.updateMe({ locale }),
    onSuccess: (_data, locale) => {
      void i18n.changeLanguage(locale);
    },
  });
  const en = i18n.language.startsWith("en");
  return (
    <Page title={t("mobile.me.language")}>
      <View style={styles.gap} />
      <GroupedList>
        <GroupedRow
          label={t("mobile.me.langPt")}
          checked={!en}
          disabled={language.isPending}
          onPress={() => language.mutate("pt-BR")}
        />
        <GroupedRow
          label={t("mobile.me.langEn")}
          checked={en}
          disabled={language.isPending}
          onPress={() => language.mutate("en")}
        />
      </GroupedList>
    </Page>
  );
}

const styles = StyleSheet.create({
  gap: { height: 14 },
  dimmed: { opacity: 0.5 },
});
