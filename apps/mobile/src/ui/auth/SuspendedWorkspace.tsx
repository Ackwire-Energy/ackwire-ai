import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { signOut } from "@/features/account";
import { suspendedOf } from "@/lib/org-choice";
import type { OrgState } from "@/providers/org";
import { Button } from "../Button";
import { useTheme } from "../theme";
import { AuthScaffold } from "./AuthScaffold";

/**
 * The chosen organization is suspended (ADR 0056 §8): say so plainly (why, when the workspace is told), with
 * the person's other organizations and Sair. It covers the app, whose socket stays open underneath, so lifting
 * the suspension brings the organization back at once.
 */
export function SuspendedWorkspace({ state }: { state: OrgState }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const suspended = suspendedOf(state.orgs, state.orgId);
  if (!suspended) return null;
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]}>
      <AuthScaffold
        title={t("standing.screen.title")}
        subtitle={
          suspended.reason ? t("standing.suspendedFor", { reason: suspended.reason }) : t("standing.screen.text")
        }
      >
        {suspended.others.map((o) => (
          <Button key={o.id} variant="secondary" wide label={o.name} onPress={() => state.setOrgId(o.id)} />
        ))}
        <Button variant="ghost" wide label={t("mobile.org.signOut")} onPress={() => void signOut()} />
      </AuthScaffold>
    </View>
  );
}
