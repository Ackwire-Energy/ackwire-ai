import { useArtifact } from "@agenteschat/client";
import { type FileLink, filePath } from "@agenteschat/client/lib/message-links";
import { type Href, router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Text as RNText, StyleSheet } from "react-native";
import { serverUrl } from "@/lib/server";
import { useOrg } from "@/providers/org";
import { Icon } from "@/ui";
import { appLinkFromUrl } from "../links/app-links";
import { useColors } from "../shared/hooks";

/**
 * A file's link in a message (the web's `FileRef`: the app's address, or the API's address of its bytes), as a pill
 * with the file's name that opens it in the app. One the reader can't open, deleted or out of reach, is the same plain
 * "Arquivo sem acesso".
 */
export function FileRefText({ link }: { link: FileLink }) {
  const { t } = useTranslation();
  const c = useColors();
  const { orgId } = useOrg();
  const query = useArtifact(link.orgId, link.artifactId, link.version ?? undefined);
  const icon = <Icon name="file" size={14} color={c.ink} />;
  if (query.isPending) {
    return (
      <RNText accessibilityLabel={t("share.fileRefNone")} style={[styles.ref, { backgroundColor: c.sunken }]}>
        {icon}
      </RNText>
    );
  }
  const a = query.data;
  if (!a) {
    return (
      <RNText style={[styles.ref, { backgroundColor: c.sunken, color: c.muted }]}>{t("share.fileRefNone")}</RNText>
    );
  }
  const open = () => {
    if (link.orgId === orgId) {
      router.push({
        pathname: "/file/[id]",
        params: { id: a.id, ...(link.version ? { v: String(link.version) } : {}) },
      });
      return;
    }
    // Another workspace's file: through `/link`, which switches to it first.
    const other = appLinkFromUrl(`${serverUrl().replace(/\/+$/, "")}${filePath(link.orgId, a.id, link.version)}`);
    if (other && "href" in other) router.push(other.href as Href);
  };
  return (
    <RNText
      accessibilityRole="link"
      accessibilityLabel={t("share.fileRef", { title: a.title })}
      onPress={open}
      style={[styles.ref, { backgroundColor: c.sunken, color: c.ink }]}
    >
      {icon} {a.title}
    </RNText>
  );
}

const styles = StyleSheet.create({
  ref: { fontWeight: "600", borderRadius: 4 },
});
