import { SOUND_STYLES, type SoundStyle } from "@agenteschat/ui/sfx";
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
            leading={<OrgAvatar name={o.name} logo={o.logo} />}
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

/** Notificações: this phone's switch. */
export function NotificationsPage() {
  const { t } = useTranslation();
  const push = usePushSwitch();
  return (
    <Page title={t("mobile.me.notifications")}>
      <View style={styles.gap} />
      <GroupedList>
        <GroupedRow
          label={t("mobile.me.notificationsPhone")}
          toggle={push.on ?? false}
          onPress={() => void push.set(!(push.on ?? false))}
        />
      </GroupedList>
      <GroupedFooter>{t("mobile.me.notificationsHint")}</GroupedFooter>
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
  const en = i18n.language.startsWith("en");
  return (
    <Page title={t("mobile.me.language")}>
      <View style={styles.gap} />
      <GroupedList>
        <GroupedRow label={t("mobile.me.langPt")} checked={!en} onPress={() => void i18n.changeLanguage("pt-BR")} />
        <GroupedRow label={t("mobile.me.langEn")} checked={en} onPress={() => void i18n.changeLanguage("en")} />
      </GroupedList>
    </Page>
  );
}

const styles = StyleSheet.create({
  gap: { height: 14 },
});
