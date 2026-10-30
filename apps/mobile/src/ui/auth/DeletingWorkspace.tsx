import { type OrgSummary, useClosingMe, useRestoreWorkspace } from "@agenteschat/client";
import { deletingText, restorable } from "@agenteschat/client/lib/deletion";
import { errorText } from "@agenteschat/client/lib/errors";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { signOut } from "@/features/account";
import type { OrgState } from "@/providers/org";
import { Button } from "../Button";
import { Text } from "../Text";
import { useToast } from "../Toast";
import { useTheme } from "../theme";
import { AuthScaffold, CENTER } from "./AuthScaffold";

/**
 * The chosen organization is being deleted: who deleted it and when, when it goes for good, and until then Restore
 * for its owners (the others read that only an owner can). Then the person's other organizations and Sair. It covers
 * the app, hidden from screen readers meanwhile. Its socket is refused, so `GET /me` is asked again: a restore brings
 * the organization back, and once it's gone it leaves the list.
 */
export function DeletingWorkspace({
  state,
  deleting,
}: {
  state: OrgState;
  /** `deletingOf` the chosen organization. */
  deleting: { org: OrgSummary; others: OrgState["orgs"] };
}) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const toast = useToast();
  const { org, others } = deleting;
  const restore = useRestoreWorkspace(org.id);
  useClosingMe();
  const owner = restorable(org);
  const due = !!org.deletion?.dueAt && Date.parse(org.deletion.dueAt) > Date.now();
  const text = org.deletion ? deletingText(t, i18n.language, org.deletion) : null;
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]} accessibilityViewIsModal>
      <AuthScaffold title={t("deleting.title", { name: org.name })} subtitle={text ?? undefined}>
        {due && !owner ? (
          <Text tone="muted" style={CENTER}>
            {t("deleting.membersOnly")}
          </Text>
        ) : null}
        {owner ? (
          <Button
            variant="primary"
            wide
            label={t("deleting.restore")}
            loading={restore.isPending}
            onPress={() =>
              restore.mutate(undefined, {
                onSuccess: () => toast({ title: t("deleting.restored", { name: org.name }) }),
                onError: (error) => toast({ title: errorText(t, error), icon: "x" }),
              })
            }
          />
        ) : null}
        {others.map((o) => (
          <Button key={o.id} variant="secondary" wide label={o.name} onPress={() => state.setOrgId(o.id)} />
        ))}
        <Button variant="ghost" wide label={t("mobile.org.signOut")} onPress={() => void signOut()} />
      </AuthScaffold>
    </View>
  );
}
