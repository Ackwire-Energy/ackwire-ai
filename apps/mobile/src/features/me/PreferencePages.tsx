import {
  type NoticeCategory,
  type StartPage as StartPageId,
  useChannels,
  useDms,
  useNoticePrefs,
  useSetNoticePref,
  useSetShowActivity,
  useSetStart,
} from "@agenteschat/client";
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
  type IconName,
  type ThemePreference,
  useTheme,
  useToast,
} from "@/ui";
import { OrgAvatar } from "../shared/OrgAvatar";
import { Page } from "./parts";

/**
 * Você's smaller screens, each pushed from its row: Workspaces, Notificações, Ao abrir o app, Respostas dos agentes,
 * Sons, Aparência and Idioma.
 */

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

/** My channels (not DMs), and what opens when the app starts among Conversas, where I left off and one of them. */
function useStartChoice() {
  const { orgId, org } = useOrg();
  const channels = useChannels(orgId);
  const dms = useDms(orgId);
  const dmIds = new Set((dms.data ?? []).map((d) => d.channelId));
  const mine = (channels.data ?? []).filter((c) => c.isMember && !dmIds.has(c.id));
  const start = org?.start;
  // A channel I'm no longer in opens Conversas: the choice says so.
  const channel = start?.page === "channel" ? mine.find((c) => c.id === start.channelId) : undefined;
  const page: StartPageId = start?.page === "last" ? "last" : channel ? "channel" : "home";
  return { mine, page, channel };
}

/** "Ao abrir o app"'s value on Você's row. */
export function useStartLabel() {
  const { t } = useTranslation();
  const { page, channel } = useStartChoice();
  if (channel) return `#${channel.name}`;
  return page === "last" ? t("mobile.me.startLast") : t("mobile.me.startHome");
}

/** Ao abrir o app (ADR 0108): Conversas, where I left off, or one of my channels, the same on every device. */
export function StartPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const { orgId } = useOrg();
  const set = useSetStart(orgId);
  const { mine, page, channel } = useStartChoice();
  const choose = (next: StartPageId, channelId: string | null = null) =>
    set.mutate({ page: next, channelId }, { onError: () => toast({ title: t("mobile.me.startFailed"), icon: "x" }) });
  return (
    <Page title={t("mobile.me.start")}>
      <View style={styles.gap} />
      <GroupedList>
        <GroupedRow label={t("mobile.me.startHome")} checked={page === "home"} onPress={() => choose("home")} />
        <GroupedRow label={t("mobile.me.startLast")} checked={page === "last"} onPress={() => choose("last")} />
      </GroupedList>
      {mine.length > 0 ? (
        <>
          <GroupedHeader>{t("mobile.me.startChannels")}</GroupedHeader>
          <GroupedList>
            {mine.map((c) => (
              <GroupedRow
                key={c.id}
                icon="hash"
                label={c.name}
                checked={channel?.id === c.id}
                onPress={() => choose("channel", c.id)}
              />
            ))}
          </GroupedList>
        </>
      ) : null}
      <GroupedFooter>{t("mobile.me.startHint")}</GroupedFooter>
    </Page>
  );
}

/** Respostas dos agentes: whether each reply shows what the agent did, the same on every device. */
export function ActivityPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const { orgId, org } = useOrg();
  const set = useSetShowActivity(orgId);
  const on = org?.showActivity === true;
  return (
    <Page title={t("mobile.me.activity")}>
      <View style={styles.gap} />
      <GroupedList>
        <GroupedRow
          label={t("mobile.me.activityShow")}
          toggle={on}
          onPress={() => set.mutate(!on, { onError: () => toast({ title: t("mobile.me.activityFailed"), icon: "x" }) })}
        />
      </GroupedList>
      <GroupedFooter>{t("mobile.me.activityHint")}</GroupedFooter>
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
  dimmed: { opacity: 0.5 },
});
