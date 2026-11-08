import { serverHost } from "@agenteschat/client/lib/server";
import { isAppLocale, localeInfo } from "@agenteschat/i18n/locale";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { chooseAction } from "@/features/settings/parts";
import { setServer, useServer, useServerToReturn } from "@/lib/server";
import { router } from "@/ui/navigation";
import { Text } from "../Text";
import { AuthLink } from "./AuthLink";

/**
 * The quiet line under the sign-in: "agentes.chat · Português · Mudar". The server this sign-in goes to and the app's
 * language are said, not offered as two links; "Mudar" is the one thing to press, and it opens the system's list with
 * both (the server's page, ADR 0154; the language's, ADR 0122). Signed in on another server (this one added from
 * Workspaces): "Voltar para …" goes back to it, still signed in there.
 */
export function AuthFootLine() {
  const { t, i18n } = useTranslation();
  const server = useServer();
  const back = useServerToReturn();
  const language = isAppLocale(i18n.language) ? localeInfo(i18n.language).native : i18n.language;
  const change = () =>
    chooseAction(
      t("mobile.auth.server.footChoose"),
      [
        { label: t("mobile.auth.server.footServer"), onPress: () => router.push("/server") },
        { label: t("mobile.auth.server.footLanguage"), onPress: () => router.push("/language") },
      ],
      t("mobile.common.cancel"),
    );
  return (
    <View style={styles.foot}>
      <Pressable
        onPress={change}
        accessibilityRole="button"
        accessibilityLabel={`${serverHost(server)}, ${language}. ${t("mobile.auth.server.footChange")}`}
        // An 18-point line: 12 of slop above and below reaches the 44-point target.
        hitSlop={12}
        style={({ pressed }) => [styles.line, pressed && styles.pressed]}
      >
        {/* The host is cut in the middle (its end says which team), the language never. */}
        <Text variant="footnote" tone="faint" numberOfLines={1} ellipsizeMode="middle" style={styles.host}>
          {serverHost(server)}
        </Text>
        <Text variant="footnote" tone="faint" numberOfLines={1}>
          {` · ${language} · `}
        </Text>
        <Text variant="footnote" tone="ink2" numberOfLines={1} style={styles.bold}>
          {t("mobile.auth.server.footChange")}
        </Text>
      </Pressable>
      {back ? (
        <AuthLink
          label={t("mobile.auth.server.backTo", { host: serverHost(back) })}
          onPress={() => void setServer(back)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  foot: { alignItems: "center", gap: 12, alignSelf: "stretch" },
  line: { flexDirection: "row", alignItems: "center", maxWidth: "100%" },
  host: { flexShrink: 1 },
  bold: { fontWeight: "600" },
  pressed: { opacity: 0.6 },
});

/** The old name, for anything still importing it: the same line. */
export const ServerLine = AuthFootLine;
