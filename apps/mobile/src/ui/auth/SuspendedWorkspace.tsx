import { useAuthConfig } from "@agenteschat/client";
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
 * to ask about it, the person's other organizations and Sair. It covers the app, whose socket stays open
 * underneath (hidden from screen readers meanwhile), so lifting the suspension brings the organization back at
 * once.
 */
export function SuspendedWorkspace({
  state,
  suspended,
}: {
  state: OrgState;
  /** `suspendedOf` the chosen organization. */
  suspended: { reason: string | null; others: OrgState["orgs"] };
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]} accessibilityViewIsModal>
      <AuthScaffold
        title={t("standing.screen.title")}
        subtitle={
          suspended.reason ? t("standing.suspendedFor", { reason: suspended.reason }) : t("standing.screen.text")
        }
      >
        <SupportLine />
        {suspended.others.map((o) => (
          <Button key={o.id} variant="secondary" wide label={o.name} onPress={() => state.setOrgId(o.id)} />
        ))}
        <Button variant="ghost" wide label={t("mobile.org.signOut")} onPress={() => void signOut()} />
      </AuthScaffold>
    </View>
  );
}

/** "Precisa de ajuda? Escreva para …" when the server says where (`SUPPORT_EMAIL`), else to ask who runs it. */
function SupportLine() {
  const { t } = useTranslation();
  const email = useAuthConfig().data?.supportEmail;
  if (!email)
    return (
      <Text tone="muted" style={CENTER}>
        {t("support.ask")}
      </Text>
    );
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
