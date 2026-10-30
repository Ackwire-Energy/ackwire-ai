import {
  type InviteLink,
  useInviteLinks,
  useJoinRequests,
  useMakeInviteLink,
  useMembers,
  useRoles,
  useTurnOffInviteLink,
} from "@agenteschat/client";
import { formatShortDate, relativeTime } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert, Share, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { GroupedHeader, GroupedList, GroupedRow } from "@/ui";
import { Page } from "../me/parts";
import { Face } from "../shared/Face";
import { useColors } from "../shared/hooks";
import { copyText, successHaptic } from "../shared/parts";
import { membersByName, roleLine } from "./logic";

/** How long "Copiado ✓" stays on the copy row. */
const COPIED_MS = 1800;

/**
 * Membros, a screen of Você's for who invites people or manages members: the requests to join (they open in their
 * sheet) and the workspace's invitation link as the web's Members has it (ADR 0068: copy or share it, when it works
 * until, turn it off; links made before links could be shown again, to turn off; make one), for who invites; then
 * the people, each with their roles (ADR 0084).
 */
export function MembersPage() {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const c = useColors();
  const members = useMembers(orgId);
  const roles = useRoles(orgId).data?.roles ?? [];
  const invites = can(org, "invite_people");
  const requests = useJoinRequests(orgId, invites);
  const links = useInviteLinks(orgId, invites);
  const make = useMakeInviteLink(orgId);
  const turnOff = useTurnOffInviteLink(orgId);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const all = links.data ?? [];
  const current = all.find((l) => l.url !== null);
  const earlier = all.filter((l) => l.url === null);
  const waiting = requests.data?.length ?? 0;
  const until = (l: InviteLink) => formatShortDate(i18n.language, l.expiresAt);

  /** Turning a link off closes its waiting requests too: the confirmation counts them. */
  const confirmTurnOff = (l: InviteLink) =>
    Alert.alert(t("members.link.turnOffTitle"), t("members.link.turnOffText", { count: l.waiting }), [
      { text: t("mobile.common.cancel"), style: "cancel" },
      { text: t("members.link.turnOff"), style: "destructive", onPress: () => turnOff.mutate(l.id) },
    ]);

  return (
    <Page title={t("members.title")}>
      <View style={styles.gap} />
      {invites ? (
        <>
          <GroupedList>
            <GroupedRow
              icon="join"
              label={t("members.requests.title")}
              value={waiting > 0 ? String(waiting) : undefined}
              chevron
              onPress={() => router.push("/join-requests")}
            />
          </GroupedList>

          <GroupedHeader>{t("members.link.title")}</GroupedHeader>
          {links.isPending ? (
            <ActivityIndicator color={c.muted} style={styles.loading} />
          ) : (
            <GroupedList>
              {current?.url ? (
                <GroupedRow
                  key="current"
                  label={current.url}
                  sub={t("members.link.help", { date: until(current) })}
                  subLines={3}
                />
              ) : null}
              {current?.url ? (
                <GroupedRow
                  key="copy"
                  icon={copied ? "check" : "copy"}
                  label={copied ? t("common.copied") : t("common.copy")}
                  onPress={() =>
                    void copyText(current.url ?? "").then((ok) => {
                      if (!ok) return;
                      successHaptic();
                      setCopied(true);
                    })
                  }
                />
              ) : null}
              {current?.url ? (
                <GroupedRow
                  key="share"
                  icon="share"
                  label={t("mobile.joinRequests.share")}
                  onPress={() =>
                    void Share.share({
                      message: t("mobile.onb.shareMessage", { org: org?.name ?? "", url: current.url ?? "" }),
                    }).catch(() => undefined)
                  }
                />
              ) : null}
              {current ? (
                <GroupedRow
                  key="off"
                  icon="x"
                  label={t("members.link.turnOff")}
                  danger
                  disabled={turnOff.isPending}
                  onPress={() => confirmTurnOff(current)}
                />
              ) : (
                <GroupedRow
                  key="make"
                  icon="plus"
                  label={t("members.link.make")}
                  disabled={make.isPending}
                  onPress={() => make.mutate()}
                />
              )}
              {earlier.map((l) => {
                const when = relativeTime(t, i18n.language, l.createdAt);
                return (
                  <GroupedRow
                    key={l.id}
                    icon="x"
                    label={t("members.link.turnOff")}
                    sub={
                      l.createdBy
                        ? t("members.link.earlier", { when, name: l.createdBy, date: until(l) })
                        : t("members.link.earlierNoName", { when, date: until(l) })
                    }
                    subLines={3}
                    danger
                    disabled={turnOff.isPending}
                    onPress={() => confirmTurnOff(l)}
                  />
                );
              })}
            </GroupedList>
          )}
        </>
      ) : null}

      <GroupedHeader>{t("members.people")}</GroupedHeader>
      {members.data ? (
        <GroupedList>
          {membersByName(members.data, i18n.language).map((m) => (
            <GroupedRow
              key={m.userId}
              leading={<Face who={{ type: "person", id: m.userId }} size={30} live={false} />}
              label={m.name}
              sub={m.email}
              value={roleLine(t, m, roles)}
            />
          ))}
        </GroupedList>
      ) : (
        <ActivityIndicator color={c.muted} style={styles.loading} />
      )}
    </Page>
  );
}

const styles = StyleSheet.create({
  gap: { height: 14 },
  loading: { marginVertical: 16 },
});
