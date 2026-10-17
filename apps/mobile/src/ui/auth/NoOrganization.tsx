import * as WebBrowser from "expo-web-browser";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { API_URL } from "@/config";
import { signOut } from "@/features/account";
import { Button } from "../Button";
import { useTheme } from "../theme";
import { AuthScaffold } from "./AuthScaffold";

/** Signed in, but in no organization: say so plainly; organizations are created on the website. */
export function NoOrganization() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]}>
      <AuthScaffold title={t("mobile.org.noneTitle")} subtitle={t("mobile.org.noneSubtitle")}>
        <Button
          variant="primary"
          wide
          icon="globe"
          label={t("mobile.org.openSite")}
          onPress={() => void WebBrowser.openBrowserAsync(API_URL)}
        />
        <Button variant="ghost" wide label={t("mobile.org.signOut")} onPress={() => void signOut()} />
      </AuthScaffold>
    </View>
  );
}
