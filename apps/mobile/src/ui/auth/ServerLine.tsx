import { serverHost } from "@agenteschat/client/lib/server";
import { isAppLocale, localeInfo } from "@agenteschat/i18n/locale";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { setServer, useServer, useServerToReturn } from "@/lib/server";
import { router } from "@/ui/navigation";
import { Text } from "../Text";
import { AuthLink } from "./AuthLink";

/**
 * The quiet line under the sign-in: "agentes.chat · Português (Brasil)", the server this sign-in goes to and the
 * app's language, each a link to its own page (the server's, ADR 0154; the language's, ADR 0122). One line where
 * there were two with different punctuation. Signed in on another server (this one added from Workspaces): "Voltar
 * para …" goes back to it, still signed in there.
 */
export function AuthFootLine() {
  const { t, i18n } = useTranslation();
  const server = useServer();
  const back = useServerToReturn();
  const language = isAppLocale(i18n.language) ? localeInfo(i18n.language).native : i18n.language;
  return (
    <View style={{ alignItems: "center", gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
        <Word label={serverHost(server)} hint={t("mobile.auth.server.change")} onPress={() => router.push("/server")} />
        <Text variant="footnote" tone="faint">
          ·
        </Text>
        <Word label={language} hint={t("shell.language")} onPress={() => router.push("/language")} />
      </View>
      {back ? (
        <AuthLink
          label={t("mobile.auth.server.backTo", { host: serverHost(back) })}
          onPress={() => void setServer(back)}
        />
      ) : null}
    </View>
  );
}

/** One word of the line, pressable: a 18-point line with 12 of slop reaches the 44-point target. */
function Word({ label, hint, onPress }: { label: string; hint: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="link"
      accessibilityLabel={`${hint}: ${label}`}
      hitSlop={12}
      style={({ pressed }) => ({ maxWidth: "70%", opacity: pressed ? 0.6 : 1 })}
    >
      <Text variant="footnote" tone="ink2" numberOfLines={1} ellipsizeMode="middle" style={{ fontWeight: "600" }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** The old name, for anything still importing it: the same line. */
export const ServerLine = AuthFootLine;
