import type { ConnectLink } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, StyleSheet, View } from "react-native";
import { Button, GroupedFooter, GroupedHeader, GroupedList, GroupedRow, InkOrbit, Segmented } from "@/ui";
import { router } from "@/ui/navigation";
import { Note } from "../ai/parts";
import { CommandBlock, Gap, SettingsPage } from "../settings/parts";
import { openComputer, openThisPhone } from "./DevicesScreen";
import { joinFacts } from "./logic";
import { ConnectedHero, DevicePortrait, JoinRequestCard } from "./parts";
import { useConnectLink, useDeviceMutation } from "./queries";

/**
 * "Conectar um dispositivo": this phone (its own guide), or a server or another computer with a one-line link, which
 * works once for 10 minutes and grants nothing by itself: the computer that runs it asks to join, live here.
 */
export function ConnectScreen({ kind }: { kind: "server" | "computer" | null }) {
  const { t } = useTranslation();
  if (kind) return <LinkFlow kind={kind} />;
  const ios = Platform.OS === "ios";
  const link = (k: "server" | "computer") =>
    router.push({ pathname: "/settings/devices/connect", params: { kind: k } });
  return (
    <SettingsPage title={t("mobile.devices.connect.title")}>
      <GroupedHeader>{t("mobile.devices.connect.thisPhone")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          icon="join"
          label={ios ? t("mobile.devices.iphone.title") : t("mobile.devices.android.entry")}
          sub={ios ? t("mobile.devices.connect.iphoneText") : t("mobile.devices.connect.androidText")}
          chevron
          onPress={() => openThisPhone()}
        />
      </GroupedList>
      <GroupedHeader>{t("mobile.devices.connect.computers")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          icon="server"
          label={t("mobile.devices.connect.server")}
          sub={t("mobile.devices.connect.serverText")}
          chevron
          onPress={() => link("server")}
        />
        <GroupedRow
          icon="laptop"
          label={t("mobile.devices.connect.computer")}
          sub={t("mobile.devices.connect.computerText")}
          chevron
          onPress={() => link("computer")}
        />
      </GroupedList>
      <GroupedFooter>{t("mobile.devices.connect.appNote")}</GroupedFooter>
    </SettingsPage>
  );
}

/** One link: its line to paste (Linux and macOS, or Windows), then the computer asking to join, then joined. */
function LinkFlow({ kind }: { kind: "server" | "computer" }) {
  const { t } = useTranslation();
  const [link, setLink] = useState<ConnectLink | null>(null);
  const [shell, setShell] = useState<"unix" | "windows">("unix");
  const make = useDeviceMutation((api, orgId, k: "server" | "computer") => api.devices.createLink(orgId, k));
  const state = useConnectLink(link?.id ?? null).data;
  const again = () => make.mutate(kind, { onSuccess: setLink });
  // biome-ignore lint/correctness/useExhaustiveDependencies: one link per visit; "Make a new link" asks again
  useEffect(again, []);
  const title = kind === "server" ? t("mobile.devices.connect.server") : t("mobile.devices.connect.computer");
  const status = state?.status ?? "waiting";
  const name = state?.request ? state.request.name || state.request.hostname : "";
  const ended = status === "denied" || status === "expired";
  return (
    <SettingsPage
      title={title}
      {...(status === "joined" && state?.machineId
        ? {
            bottom: (
              <Button
                variant="primary"
                wide
                label={t("mobile.common.done")}
                onPress={() => (state.machineId ? openComputer(state.machineId) : undefined)}
              />
            ),
          }
        : {})}
    >
      {status === "joined" ? (
        <>
          <Gap />
          <ConnectedHero
            portrait={
              <DevicePortrait computer={{ os: state?.request?.os ?? "linux", status: { kind: "ready" } }} size={96} />
            }
            title={t("mobile.devices.connect.joined", { name })}
            line={state?.request ? joinFacts(t, state.request) : ""}
          />
        </>
      ) : status === "asking" && state?.request ? (
        <>
          <GroupedHeader>{t("mobile.devices.join.header")}</GroupedHeader>
          <JoinRequestCard request={state.request} />
        </>
      ) : (
        <>
          <Gap />
          {/* An ended link has no line left to pick: only why, and a new link. */}
          {ended ? null : (
            <>
              <Segmented
                items={[
                  { key: "unix", label: t("mobile.devices.connect.unix") },
                  { key: "windows", label: t("mobile.devices.connect.windows") },
                ]}
                value={shell}
                onChange={(k) => setShell(k as "unix" | "windows")}
                wide
              />
              <Gap />
              {link ? (
                <CommandBlock command={link.commands[shell]} copiedTitle={t("mobile.devices.connect.copied")} />
              ) : null}
              <GroupedFooter>{t("mobile.devices.connect.once")}</GroupedFooter>
            </>
          )}
          <View style={styles.live}>
            {make.isError ? (
              <Note icon="x">{errorText(t, make.error)}</Note>
            ) : ended ? (
              <Note icon="x">
                {status === "denied"
                  ? t("mobile.devices.connect.denied", { name })
                  : t("mobile.devices.connect.expired")}
              </Note>
            ) : link ? (
              <Note icon={<InkOrbit size={15} />} live>
                {t("mobile.devices.connect.waiting")}
              </Note>
            ) : null}
            {ended || make.isError ? (
              <View style={styles.inset}>
                <Button
                  size="sm"
                  variant="secondary"
                  label={t("mobile.devices.connect.again")}
                  disabled={make.isPending}
                  onPress={again}
                />
              </View>
            ) : null}
          </View>
        </>
      )}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  // The note and its button start where the footer's words above them do (the note pads itself by 4).
  live: { paddingHorizontal: 12, paddingTop: 16, gap: 12, alignItems: "flex-start" },
  inset: { paddingHorizontal: 4 },
});
