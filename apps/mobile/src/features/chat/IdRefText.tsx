import { useIdRef } from "@agenteschat/client";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Text as RNText, StyleSheet } from "react-native";
import { useOrg } from "@/providers/org";
import { Icon } from "@/ui";
import { useColors } from "../shared/hooks";
import { MessageRefText } from "./MessageRefText";

/**
 * An internal id written in a text (the web's `IdRef`), as the pill of what it names for this reader: a file (opens it),
 * a task ("#13 title", opens it), a message (its link's pill). While it loads, a quiet pill, so the id never shows on
 * its way to its name; one that names nothing the reader sees stays as written.
 */
export function IdRefText({ id, text }: { id: string; text: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const { orgId } = useOrg();
  const query = useIdRef(orgId, id);
  const ref = query.data;
  if (query.isPending) {
    return (
      <RNText style={[styles.ref, { backgroundColor: c.sunken }]}>
        <Icon name="more" size={14} color={c.muted} />
      </RNText>
    );
  }
  if (!ref) return <RNText>{text}</RNText>;
  if (ref.kind === "message") {
    const m = ref.message;
    return (
      <MessageRefText
        link={{ orgId, messageId: m.id, channelId: m.threadId ? null : m.channelId, threadId: m.threadId }}
      />
    );
  }
  const file = ref.kind === "file";
  return (
    <RNText
      accessibilityRole="link"
      accessibilityLabel={file ? t("artifacts.open", { title: ref.title }) : undefined}
      onPress={() =>
        file ? router.push({ pathname: "/file/[id]", params: { id: ref.id } }) : router.push(`/issues/${ref.number}`)
      }
      style={[styles.ref, { backgroundColor: c.sunken, color: c.ink }]}
    >
      <Icon name={file ? "doc" : "issue"} size={14} color={c.ink} /> {file ? ref.title : `#${ref.number} ${ref.title}`}
    </RNText>
  );
}

const styles = StyleSheet.create({
  ref: { fontWeight: "600", borderRadius: 4 },
});
