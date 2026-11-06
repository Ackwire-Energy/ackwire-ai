import { type OrgSummary, useClosingMe, useRestoreWorkspace } from "@agenteschat/client";
import {
  deletedByText,
  deletingText,
  restorable,
  workspaceLabel,
  workspaceNotes,
  workspaceOpens,
} from "@agenteschat/client/lib/deletion";
import { errorText } from "@agenteschat/client/lib/errors";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { signOut } from "@/features/account";
import type { OrgState } from "@/providers/org";
import { Button } from "../Button";
import { Text } from "../Text";
import { useToast } from "../Toast";
import { useTheme } from "../theme";
import { AuthScaffold, CENTER } from "./AuthScaffold";
import { WholeAccount } from "./WholeAccount";

/**
 * The chosen organization is being deleted: that nothing more is needed and when it goes, who deleted it, and until
 * then Restore for its owners (the others read that only an owner can). Going to another organization is the main
 * action; then a new one (the first run, `onNewWorkspace`, where they may make one) and Sair. Apagar conta only for
 * someone with nowhere else to reach it (`WholeAccount`; its screen opens over this one). It covers the app, hidden
 * from screen readers meanwhile. Its socket is refused, so `GET /me` is asked again: a restore brings the organization
 * back, and once it's gone it leaves the list.
 */
export function DeletingWorkspace({
  state,
  deleting,
  onNewWorkspace,
}: {
  state: OrgState;
  /** `deletingOf` the chosen organization. */
  deleting: { org: OrgSummary; others: OrgState["orgs"] };
  onNewWorkspace: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const toast = useToast();
  const { org, others } = deleting;
  const restore = useRestoreWorkspace(org.id);
  const me = useClosingMe().data;
  const owner = restorable(org);
  const due = !!org.deletion?.dueAt && Date.parse(org.deletion.dueAt) > Date.now();
  const text = org.deletion ? deletingText(t, i18n.language, org.deletion) : undefined;
  const by = org.deletion ? deletedByText(t, i18n.language, org.deletion) : null;
  const notes = workspaceNotes(t, i18n.language, state.orgs);
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]} accessibilityViewIsModal>
      <AuthScaffold title={t("deleting.title", { name: org.name })} subtitle={text}>
        {by ? (
          <Text tone="muted" style={CENTER}>
            {by}
          </Text>
        ) : null}
        {due && !owner ? (
          <Text tone="muted" style={CENTER}>
            {t("deleting.membersOnly")}
          </Text>
        ) : null}
        {others.map((o, i) => (
          <Button
            key={o.id}
            variant={i === 0 && workspaceOpens(o) ? "primary" : "secondary"}
            wide
            label={workspaceLabel(o.name, notes.get(o.id))}
            onPress={() => state.setOrgId(o.id)}
          />
        ))}
        {owner ? (
          <Button
            variant={others.some(workspaceOpens) ? "secondary" : "primary"}
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
        {me && me.user.canCreateWorkspace !== false ? (
          <Button variant="secondary" wide label={t("shell.newWorkspace")} onPress={onNewWorkspace} />
        ) : null}
        <Button variant="ghost" wide label={t("mobile.org.signOut")} onPress={() => void signOut()} />
        <WholeAccount orgs={state.orgs} onDelete={() => router.push("/account-delete")} />
      </AuthScaffold>
    </View>
  );
}
