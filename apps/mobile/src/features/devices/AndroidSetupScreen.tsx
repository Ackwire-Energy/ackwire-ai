import type { PhoneDevice } from "@agenteschat/client";
import { computerName } from "@agenteschat/client/lib/computer";
import { wifiPairLive, wifiPairText } from "@agenteschat/client/lib/devices";
import { errorText } from "@agenteschat/client/lib/errors";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import * as Device from "expo-device";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, StyleSheet, TextInput, View } from "react-native";
import { useOrg } from "@/providers/org";
import {
  Button,
  CodeInput,
  fieldText,
  GroupedField,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Icon,
  InkOrbit,
  Locked,
  Text,
  useTheme,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { Note, Step, StepsCard, StepText } from "../ai/parts";
import { Gap, SettingsPage } from "../settings/parts";
import { useMeId } from "../shared/hooks";
import { pickOne } from "../shared/PickerSheet";
import { goBack } from "../shared/parts";
import { androidStage, phoneFacts, phoneHosts, reasonText, thisPhoneOn } from "./logic";
import { ConnectedHero, DevicePortrait, PhoneNameField, useAudienceText } from "./parts";
import { useDevices, useWifiPairCode } from "./queries";

/** Android's Settings screens, each with the row to light up (AOSP's `:settings:fragment_args_key`). */
const SCREENS = {
  about: { action: "android.settings.DEVICE_INFO_SETTINGS", row: "build_number" },
  usb: { action: "android.settings.APPLICATION_DEVELOPMENT_SETTINGS", row: "enable_adb" },
  wifi: { action: "android.settings.APPLICATION_DEVELOPMENT_SETTINGS", row: "toggle_adb_wireless" },
} as const;

/** The computer a phone plugs into: the one named, one already seeing this phone, or the person's only one. */
function useHost(machineId: string | undefined) {
  const list = useDevices(4000);
  const meId = useMeId();
  const [picked, setPicked] = useState<string | null>(machineId ?? null);
  const devices = list.data?.devices ?? [];
  const hosts = phoneHosts(devices, meId, "android");
  const seeing = devices.find((d) => thisPhoneOn(d.phones, "android", Device.modelName));
  const host = devices.find((d) => d.id === picked) ?? seeing ?? (hosts.length === 1 ? hosts[0] : undefined);
  return { list, hosts, host, setPicked };
}

/**
 * "Deixar agentes usarem este celular", on the Android phone itself: Developer options and USB debugging with buttons
 * that open those exact screens, then the cable into the computer, with a live line from what the computer reports
 * (not seen yet, waiting for Allow, ready), and Android's own prompt drawn in the app's language. Ready, it says so,
 * with the phone's name and who can use it. No cable: Wireless debugging, then the QR agentes.chat shows on a
 * computer, or the six-digit code typed here.
 */
export function AndroidSetupScreen({ machineId }: { machineId?: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { org } = useOrg();
  const { list, hosts, host, setPicked } = useHost(machineId);
  const [opened, setOpened] = useState({ about: false, usb: false, wifi: false });
  const [wifi, setWifi] = useState(false);
  const [byCode, setByCode] = useState(false);
  const pairing = useWifiPairCode(host?.id ?? null);
  const hostName = host
    ? computerName(t, org?.name ?? "", { kind: host.machineKind, name: host.name }, isPersonal(org))
    : "";
  const pairedId = pairing.pairing?.phoneId;
  const phone = host
    ? ((pairedId ? host.phones.find((p) => p.id === pairedId) : undefined) ??
      thisPhoneOn(host.phones, "android", Device.modelName))
    : null;
  const stage = androidStage(phone);
  if (host && phone && stage === "done") return <AndroidDone phone={phone} hostName={hostName} />;

  const open = (screen: keyof typeof SCREENS) => {
    const s = SCREENS[screen];
    Linking.sendIntent(s.action, [{ key: ":settings:fragment_args_key", value: s.row }]).then(
      () => setOpened((o) => ({ ...o, [screen]: true })),
      () => toast({ title: t("mobile.devices.android.openFailed"), icon: "x" }),
    );
  };
  const choose = async () => {
    const key = await pickOne({
      title: t("mobile.devices.android.computer"),
      options: hosts.map((h) => ({ key: h.id, label: h.name })),
      value: host?.id ?? null,
    });
    if (key) setPicked(key);
  };
  // Seen by the computer at all: USB debugging is on, so the first two steps are done whatever was tapped here.
  const seen = stage !== "looking";
  const hostDown = host?.status.kind === "offline";
  const reason = phone && phone.status.kind !== "offline" && "reason" in phone.status ? phone.status.reason : null;
  const liveLine = hostDown ? (
    <Note icon="x">{t("mobile.devices.android.hostOffline", { host: hostName })}</Note>
  ) : (
    <Note icon={<InkOrbit size={15} />} live>
      {t("mobile.devices.android.looking")}
    </Note>
  );
  return (
    <SettingsPage
      title={t("mobile.devices.android.title")}
      subtitle={host ? t("mobile.devices.android.connecting", { host: hostName }) : undefined}
    >
      {hosts.length > 1 ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow
              label={t("mobile.devices.android.computer")}
              value={hostName}
              menu
              onPress={() => void choose()}
            />
          </GroupedList>
        </>
      ) : null}
      {!host && list.isSuccess ? (
        <View style={styles.block}>
          <Note icon="info">{t("mobile.devices.android.noHost")}</Note>
          <Button
            size="sm"
            variant="secondary"
            label={t("mobile.devices.connect.title")}
            onPress={() => router.push("/settings/devices/connect")}
          />
        </View>
      ) : null}
      {host && !wifi ? (
        <View style={styles.steps}>
          <StepsCard>
            <Step
              n={1}
              title={t("mobile.devices.android.step1")}
              state={seen || opened.about ? "done" : "now"}
              side={
                <Button
                  size="sm"
                  variant="secondary"
                  icon="out"
                  label={t("mobile.devices.android.openAbout")}
                  onPress={() => open("about")}
                />
              }
            >
              {seen || opened.about ? null : <StepText>{t("mobile.devices.android.step1Text")}</StepText>}
            </Step>
            <Step
              n={2}
              divider
              title={t("mobile.devices.android.step2")}
              state={seen || opened.usb ? "done" : opened.about ? "now" : "later"}
              side={
                <Button
                  size="sm"
                  variant="secondary"
                  icon="out"
                  label={t("mobile.devices.android.openDev")}
                  onPress={() => open("usb")}
                />
              }
            />
            <Step
              n={3}
              divider
              title={t("mobile.devices.android.step3", { host: hostName })}
              hint={t("mobile.devices.android.step3Hint")}
              state={seen ? "done" : opened.usb ? "now" : "later"}
            >
              {seen ? null : liveLine}
            </Step>
            <Step n={4} divider title={t("mobile.devices.android.step4")} state={seen ? "now" : "later"}>
              <StepText>{t("mobile.devices.android.step4Text")}</StepText>
              {reason && reason !== "unauthorized" ? <Note icon="info">{reasonText(t, reason)}</Note> : null}
              <AdbPrompt />
            </Step>
          </StepsCard>
        </View>
      ) : null}
      {host && wifi ? (
        <View style={styles.steps}>
          <StepsCard>
            <Step
              n={1}
              title={t("mobile.devices.android.wifi1")}
              state={seen || opened.wifi ? "done" : "now"}
              side={
                <Button
                  size="sm"
                  variant="secondary"
                  icon="out"
                  label={t("mobile.devices.android.openDev")}
                  onPress={() => open("wifi")}
                />
              }
            >
              {seen || opened.wifi ? null : <StepText>{t("mobile.devices.android.wifi1Text")}</StepText>}
            </Step>
            <Step
              n={2}
              divider
              title={t("mobile.devices.android.wifi2")}
              hint={t("mobile.devices.android.wifi2Hint", { host: hostName })}
              state={seen ? "done" : opened.wifi ? "now" : "later"}
            >
              <StepText>{t("mobile.devices.android.wifi2Text")}</StepText>
              {seen || byCode ? null : liveLine}
            </Step>
          </StepsCard>
          <Gap />
          {byCode ? (
            <PairByCode pairing={pairing} hostName={hostName} />
          ) : (
            <GroupedList>
              <GroupedRow icon="key" label={t("devices.wifiPair.useCode")} chevron onPress={() => setByCode(true)} />
            </GroupedList>
          )}
          <GroupedFooter>{t("mobile.devices.android.wifiNote")}</GroupedFooter>
        </View>
      ) : null}
      {host ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow
              icon={wifi ? "join" : "wifi"}
              label={wifi ? t("mobile.devices.android.cable") : t("mobile.devices.android.wifi")}
              {...(wifi ? {} : { sub: t("mobile.devices.android.wifiText") })}
              chevron
              onPress={() => setWifi((w) => !w)}
            />
          </GroupedList>
        </>
      ) : null}
    </SettingsPage>
  );
}

/**
 * The six-digit way, typed on this phone: the address and the code Pair device with pairing code shows, sent to the
 * computer, which pairs and connects; the line under them follows it, and a failure leaves both to fix and send again.
 */
function PairByCode({ pairing, hostName }: { pairing: ReturnType<typeof useWifiPairCode>; hostName: string }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const p = pairing.pairing;
  const busy = pairing.pending || wifiPairLive(p);
  const failed = Boolean(pairing.error) || p?.state === "failed";
  const ready = /^\S+:\d{1,5}$/.test(address.trim()) && /^\d{6}$/.test(code);
  const line = pairing.error ? errorText(t, pairing.error) : p ? wifiPairText(t, p, hostName) : null;
  const send = () => {
    if (ready && !busy) pairing.pair({ address: address.trim(), code });
  };
  return (
    <View style={styles.code}>
      <Locked when={busy} style={styles.code}>
        <View>
          <GroupedHeader>{t("mobile.devices.android.codeHead")}</GroupedHeader>
          <GroupedList>
            <GroupedField label={t("devices.wifiPair.address")}>
              <TextInput
                value={address}
                onChangeText={setAddress}
                placeholder={t("devices.wifiPair.addressExample")}
                placeholderTextColor={c.faint}
                keyboardType="numbers-and-punctuation"
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                maxLength={80}
                accessibilityLabel={t("devices.wifiPair.address")}
                style={[fieldText("callout"), styles.input, { color: c.ink }]}
              />
            </GroupedField>
          </GroupedList>
        </View>
        <View>
          <GroupedHeader>{t("devices.wifiPair.pairingCode")}</GroupedHeader>
          <CodeInput
            length={6}
            value={code}
            onChange={setCode}
            label={t("devices.wifiPair.pairingCode")}
            error={failed}
            onSubmit={send}
          />
          <GroupedFooter>{t("mobile.devices.android.codeNote")}</GroupedFooter>
        </View>
      </Locked>
      {line ? (
        <Note icon={failed ? "x" : <InkOrbit size={15} />} live>
          {line}
        </Note>
      ) : null}
      <Button
        variant="primary"
        wide
        label={t("devices.wifiPair.pair")}
        disabled={!ready || busy}
        loading={busy}
        onPress={send}
      />
    </View>
  );
}

/** Android's "Allow USB debugging?" as the phone draws it (Material 3), with its words in the app's language. */
function AdbPrompt() {
  const { t } = useTranslation();
  const { scheme } = useTheme();
  // The system's own colors, not the app's: it is a drawing of Android's dialog.
  const k = scheme === "dark" ? ANDROID_DARK : ANDROID_LIGHT;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={t("mobile.devices.android.prompt.a11y")}
      style={[styles.dialog, { backgroundColor: k.surface }]}
    >
      <Text variant="callout" style={{ color: k.ink }}>
        {t("mobile.devices.android.prompt.title")}
      </Text>
      <Text variant="footnote" style={{ color: k.muted }}>
        {`${t("mobile.devices.android.prompt.fingerprint")}\n${FINGERPRINT}`}
      </Text>
      <View style={[styles.check, { borderColor: k.accent, backgroundColor: k.tint }]}>
        <View style={[styles.box, { backgroundColor: k.accent }]}>
          <Icon name="check" size={12} color={k.surface} />
        </View>
        <Text variant="footnote" style={[styles.grow, { color: k.ink }]}>
          {t("mobile.devices.android.prompt.always")}
        </Text>
      </View>
      <View style={styles.actions}>
        <Text variant="footnote" style={[styles.action, { color: k.accent }]}>
          {t("mobile.devices.android.prompt.cancel")}
        </Text>
        <Text variant="footnote" style={[styles.action, { color: k.accent }]}>
          {t("mobile.devices.android.prompt.allow")}
        </Text>
      </View>
    </View>
  );
}

/** A sample key's fingerprint: the drawing shows where it goes, the phone shows the real one. */
const FINGERPRINT = "5A:3F:C2:8E:41:D7:09:B6:2C:E5:73:1A:F8:64:9D:0B";
const ANDROID_LIGHT = {
  surface: "#ece6f0",
  ink: "#1d1b20",
  muted: "#49454f",
  accent: "#0b57d0",
  tint: "rgba(11,87,208,0.08)",
};
const ANDROID_DARK = {
  surface: "#2b2930",
  ink: "#e6e0e9",
  muted: "#cac4d0",
  accent: "#a8c7fa",
  tint: "rgba(168,199,250,0.12)",
};

/** The phone is ready: its portrait, "Pixel 8 is connected", its name and who can use it, and Done. */
function AndroidDone({ phone: p, hostName }: { phone: PhoneDevice; hostName: string }) {
  const { t } = useTranslation();
  const audienceText = useAudienceText();
  return (
    <SettingsPage
      title={t("mobile.devices.android.title")}
      bottom={<Button variant="primary" wide label={t("mobile.common.done")} onPress={goBack} />}
    >
      <Gap />
      <ConnectedHero
        portrait={<DevicePortrait phone={p} size={96} />}
        title={t("mobile.devices.android.done", { name: p.name })}
        line={phoneFacts(t, p, hostName)}
      />
      <Gap />
      <GroupedList>
        <PhoneNameField key={p.name} phone={p} />
        <GroupedRow
          label={t("mobile.devices.audience.label")}
          value={audienceText(p.audience, p.ownerUserId, hostName)}
          chevron
          onPress={() => router.push({ pathname: "/settings/devices/audience", params: { id: p.id } })}
        />
      </GroupedList>
      <GroupedFooter>{t("mobile.devices.page.shareNote", { host: hostName })}</GroupedFooter>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  block: { paddingHorizontal: 4, paddingTop: 16, gap: 12, alignItems: "flex-start" },
  steps: { paddingTop: 12 },
  code: { gap: 16 },
  input: { flex: 1, minWidth: 0, paddingVertical: 12, paddingHorizontal: 0 },
  dialog: { marginTop: 8, borderRadius: 20, paddingTop: 16, paddingHorizontal: 16, paddingBottom: 8, gap: 4 },
  check: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 8,
    marginHorizontal: -8,
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: 12,
    borderWidth: 2,
  },
  box: { width: 16, height: 16, borderRadius: 4, alignItems: "center", justifyContent: "center" },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 4, marginTop: 4 },
  action: { fontWeight: "500", paddingVertical: 8, paddingHorizontal: 12 },
  grow: { flex: 1, minWidth: 0 },
});
