import { useAuthConfig } from "@agenteschat/client";
import { supportLineOf, suspendedText } from "@agenteschat/client/lib/errors";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Linking, StyleSheet, View } from "react-native";
import { signOut } from "@/features/account";
import type { OrgState } from "@/providers/org";
import { Button } from "../Button";
import { Text } from "../Text";
import { useTheme } from "../theme";
import { AuthScaffold, CENTER } from "./AuthScaffold";

/**
 * The chosen organization is suspended (ADR 0056 §8): say so plainly (why, when the workspace is told), where
 * to ask about it, the person's other organizations, Sair and Apagar conta (its screen opens over this one). It
 * covers the app, whose socket stays open underneath (hidden from screen readers meanwhile), so lifting the
 * suspension brings the organization back at once.
 */
export function SuspendedWorkspace({
  state,
  suspended,
}: {
  state: OrgState;
  /** `suspendedOf` the chosen organization. */
  suspended: { reason: string | null; cloud: boolean; others: OrgState["orgs"] };
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]} accessibilityViewIsModal>
      <AuthScaffold title={t("standing.screen.title")} subtitle={suspendedText(t, suspended)}>
        <SupportLine />
        {suspended.others.map((o) => (
          <Button key={o.id} variant="secondary" wide label={o.name} onPress={() => state.setOrgId(o.id)} />
        ))}
        <Button variant="ghost" wide label={t("mobile.org.signOut")} onPress={() => void signOut()} />
        <Button variant="ghost" wide label={t("deleteAccount.menu")} onPress={() => router.push("/account-delete")} />
      </AuthScaffold>
    </View>
  );
}

/** "Precisa de ajuda? Escreva para …", or to ask who runs the server, as `supportLineOf` says. */
function SupportLine() {
  const { t } = useTranslation();
  const line = supportLineOf(useAuthConfig().data);
  if (!line) return null;
  if (line === "ask")
    return (
      <Text tone="muted" style={CENTER}>
        {t("support.ask")}
      </Text>
    );
  const { email } = line;
  return (
    <Text tone="muted" style={CENTER}>
      {t("support.writeBefore")}
      <Text
        tone="muted"
        accessibilityRole="link"
        style={{ textDecorationLine: "underline" }}
        onPress={() => void Linking.openURL(`mailto:${email}`)}
      >
        {email}
      </Text>
      {t("support.writeAfter")}
    </Text>
  );
}
