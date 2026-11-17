import { CLOUD_SERVER, HOSTING_FOOT, HOSTING_POINTS, helpUrl } from "@agenteschat/client/lib/server";
import { DOWNLOAD_URL } from "@agenteschat/i18n/docs";
import { HOSTING_CAST, type Hosting, teamTones } from "@agenteschat/ui/sky/team";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { AgentAvatar } from "@/agent/AgentAvatar";
import { ComputerPortrait } from "@/computer/ComputerPortrait";
import { setServer } from "@/lib/server";
import { Dither } from "@/sky/Dither";
import { useOnCloud } from "@/ui/auth/ServerLine";
import { Button } from "@/ui/Button";
import { Icon, type IconName } from "@/ui/Icon";
import { router } from "@/ui/navigation";
import { SheetScreen } from "@/ui/SheetScreen";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { openPage } from "../ai/parts";
import { whereAction } from "./where";

/** The web's line icons, as the phone draws them. */
const PHONE_ICON: Record<(typeof HOSTING_POINTS)[Hosting][number][1], IconName> = {
  check: "check",
  database: "server",
  refresh: "replay",
  power: "moon",
};

/** The band over the sheet: day over the Cloud's always-on server, night over a dark laptop with the team asleep. */
function Scene({ hosting }: { hosting: Hosting }) {
  const { colors } = useTheme();
  const cloud = hosting === "cloud";
  return (
    <View style={styles.band} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Dither kind="sky" tones={teamTones(cloud ? 1 : 0, colors.raised)} pixel={4} style={StyleSheet.absoluteFill} />
      <View style={styles.row}>
        <View style={styles.cast}>
          {HOSTING_CAST.map((a) => (
            <AgentAvatar
              key={a.name}
              agent={{ ...a.look, id: a.name }}
              size={a.name === "b" ? 52 : 40}
              mode={cloud ? "idle" : "sleep"}
              framed={false}
              expression={cloud ? "happy" : undefined}
            />
          ))}
        </View>
        <View style={styles.trail}>
          {[0, 1, 2, 3].map((n) => (
            <View key={n} style={[styles.pixel, cloud ? styles.lit : null]} />
          ))}
        </View>
        <ComputerPortrait kind={cloud ? "linux" : "mac"} state={cloud ? "online" : "offline"} size={96} />
      </View>
    </View>
  );
}

/** One option: its name and pill, then its points while chosen (its one-line summary otherwise). No radio dot. */
function Option({ hosting, on, onPress }: { hosting: Hosting; on: boolean; onPress: () => void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const cloud = hosting === "cloud";
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      style={[
        styles.option,
        { backgroundColor: colors.raised, borderColor: on ? colors.ink : colors.line },
        on ? styles.optionOn : null,
      ]}
    >
      <View style={styles.optionHead}>
        <Text variant="callout" style={styles.optionName}>
          {t(`hosting.${hosting}.name`)}
        </Text>
        <View style={[styles.pill, { backgroundColor: cloud ? colors.agentSoft : colors.chip }]}>
          <Text variant="caption" style={[styles.pillText, { color: cloud ? colors.agent : colors.muted }]}>
            {t(cloud ? "hosting.recommended" : "hosting.free")}
          </Text>
        </View>
      </View>
      {on ? (
        <View style={styles.points}>
          {HOSTING_POINTS[hosting].map(([key, icon]) => (
            <View key={key} style={styles.point}>
              <Icon name={PHONE_ICON[icon]} size={16} color={colors.muted} />
              <Text variant="footnote" tone="ink2" style={styles.pointText}>
                {t(key)}
              </Text>
            </View>
          ))}
          <Text variant="caption">{t(HOSTING_FOOT[hosting])}</Text>
        </View>
      ) : (
        <Text variant="footnote" tone="muted">
          {t(`hosting.${hosting}.short`)}
        </Text>
      )}
    </Pressable>
  );
}

/**
 * "Onde fica o seu workspace?" (the web's sheet, from the sign-in's Trocar): the Cloud chosen and recommended, one's
 * own server free beside it, each said by what it takes on. One's own server goes to its address screen (which scans
 * a QR code too); "Ainda não tem um?" lists the two ways to have one, and a way back to the Cloud. The Cloud goes
 * back to it.
 */
export function WhereSheet() {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const onCloud = useOnCloud();
  const [pick, setPick] = useState<Hosting>(onCloud ? "cloud" : "own");
  const [getting, setGetting] = useState(false);
  const go = () => {
    const action = whereAction(pick, onCloud);
    if (action === "address") return router.replace("/server");
    if (action === "cloud") void setServer(CLOUD_SERVER);
    router.back();
  };
  return (
    <SheetScreen fit>
      <Scene hosting={pick} />
      <Text variant="title" accessibilityRole="header">
        {t("hosting.title")}
      </Text>
      <View accessibilityRole="radiogroup" style={styles.options}>
        {(["cloud", "own"] as const).map((h) => (
          <Option key={h} hosting={h} on={pick === h} onPress={() => setPick(h)} />
        ))}
      </View>
      {pick === "own" ? (
        getting ? (
          <View style={[styles.get, { borderColor: colors.line }]}>
            <Text variant="label">{t("hosting.get.server")}</Text>
            <Text variant="footnote" tone="muted">
              {t("hosting.get.serverText")}
            </Text>
            <Button
              variant="secondary"
              size="sm"
              label={t("hosting.get.serverAction")}
              onPress={() => openPage(helpUrl("install-on-a-server", i18n.language))}
            />
            <Text variant="label" style={styles.getNext}>
              {t("hosting.get.here")}
            </Text>
            <Text variant="footnote" tone="muted">
              {t("hosting.get.hereText")}
            </Text>
            <View style={styles.getActs}>
              <Button
                variant="secondary"
                size="sm"
                label={t("hosting.get.download")}
                onPress={() => openPage(DOWNLOAD_URL)}
              />
              <Button
                variant="secondary"
                size="sm"
                label={t("hosting.get.how")}
                onPress={() => openPage(helpUrl("run-on-your-computer", i18n.language))}
              />
            </View>
            <Pressable
              onPress={() => {
                setGetting(false);
                setPick("cloud");
              }}
              accessibilityRole="button"
              hitSlop={12}
              style={styles.getNext}
            >
              <Text variant="footnote" tone="muted">
                {t("hosting.get.foot")}{" "}
                <Text variant="footnote" tone="ink2" style={styles.bold}>
                  {t("hosting.get.footLink")}
                </Text>
              </Text>
            </Pressable>
          </View>
        ) : (
          <Pressable onPress={() => setGetting(true)} accessibilityRole="button" hitSlop={12}>
            <Text variant="footnote" tone="muted">
              {t("hosting.own.none")}{" "}
              <Text variant="footnote" tone="ink2" style={styles.bold}>
                {t("hosting.own.noneLink")}
              </Text>
            </Text>
          </Pressable>
        )
      ) : null}
      <Button
        variant="primary"
        wide
        label={pick === "cloud" ? t("hosting.cloud.enter") : t("hosting.own.connect")}
        onPress={go}
      />
    </SheetScreen>
  );
}

const styles = StyleSheet.create({
  band: { height: 132, borderRadius: 14, overflow: "hidden" },
  row: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 16,
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "center",
    gap: 12,
  },
  cast: { flexDirection: "row", alignItems: "flex-end", gap: 6 },
  trail: { flexDirection: "row", gap: 5, alignSelf: "center" },
  pixel: { width: 6, height: 6, backgroundColor: "#ffffff40" },
  lit: { backgroundColor: "#ffffff" },
  options: { gap: 8 },
  option: { borderRadius: 14, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 12, gap: 4 },
  optionOn: { borderWidth: 1.5 },
  optionHead: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  optionName: { fontWeight: "600", flexShrink: 1 },
  pill: { marginLeft: "auto", height: 22, paddingHorizontal: 8, borderRadius: 11, justifyContent: "center" },
  pillText: { fontWeight: "600" },
  points: { gap: 4, marginTop: 2 },
  point: { flexDirection: "row", alignItems: "center", gap: 8 },
  pointText: { flexShrink: 1 },
  bold: { fontWeight: "600" },
  get: { borderWidth: 1, borderRadius: 14, padding: 16, gap: 4 },
  getNext: { marginTop: 12 },
  getActs: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
});
