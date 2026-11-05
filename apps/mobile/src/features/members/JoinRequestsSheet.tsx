import {
  type JoinRequest,
  type OrgRole,
  useApproveJoinRequest,
  useDenyJoinRequest,
  useJoinRequests,
  useRoles,
  useWorkspaceLimits,
} from "@agenteschat/client";
import { knownErrorText } from "@agenteschat/client/lib/errors";
import { approvalNews, JOIN_REASON_MAX } from "@agenteschat/client/lib/join-requests";
import { membersFull } from "@agenteschat/client/lib/limits";
import { can } from "@agenteschat/client/lib/permissions";
import { sortRoles } from "@agenteschat/client/lib/roles";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Share, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import {
  Button,
  Chip,
  GroupedList,
  GroupedRow,
  InfoHint,
  Locked,
  PersonAvatar,
  SheetScreen,
  Text,
  useToast,
} from "@/ui";
import { useColors } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { successHaptic, useSurface } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { focusedFirst, requestChips } from "./logic";
import { MembersFullNote } from "./MembersFullNote";

/**
 * Requests to join through the invitation link (ADR 0068), as a native form sheet: the web's Members › Requests on
 * the phone, opened by the push, Atividade's card and `agenteschat://join-requests`. Each is approved, with any of
 * the roles the approver may give (ADR 0085; none: only what everyone may do), or denied with a reason the person
 * reads in the email. On a server that sends no email, approving hands the approver the invitation's link to share.
 * `focus`: the request tapped on Membros, on top. With no room left nobody can be approved, as on the web.
 */
export function JoinRequestsSheet({ focus, onClose }: { focus?: string | undefined; onClose: () => void }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const c = useColors();
  const allowed = can(org, "invite_people");
  const list = useJoinRequests(orgId, allowed);
  const roles = useRoles(orgId);
  const full = membersFull(useWorkspaceLimits(orgId).data) !== null;
  // The roles the approver may give: the custom ones below their own (`givable`), top first.
  const givable = sortRoles((roles.data?.roles ?? []).filter((r) => r.givable));
  // Every link handed over stays until the sheet closes: each is returned once, and the Share sheet can be dismissed.
  const [handOffs, setHandOffs] = useState<{ name: string; url: string }[]>([]);
  const orgName = org?.name ?? "";
  const share = (url: string) =>
    void Share.share({ message: t("mobile.onb.shareMessage", { org: orgName, url }) }).catch(() => undefined);

  let body: ReactNode;
  if (!allowed) body = <Text tone="muted">{t("common.notAllowed")}</Text>;
  else if (!list.data)
    body = list.isError ? <Text tone="muted">{t("mobile.app.failed")}</Text> : <ActivityIndicator color={c.muted} />;
  else if (list.data.length === 0)
    body = (
      <>
        <Text tone="muted">{t("members.requests.empty")}</Text>
        <Button variant="secondary" wide label={t("mobile.common.close")} onPress={onClose} />
      </>
    );
  else
    body = focusedFirst(list.data, focus).map((r) => (
      <RequestCard
        key={r.id}
        request={r}
        roles={givable}
        full={full}
        onSend={(url) => {
          setHandOffs((all) => [...all, { name: r.name, url }]);
          share(url);
        }}
      />
    ));

  return (
    <SheetScreen>
      <SheetTitle title={t("members.requests.title")} subtitle={orgName || undefined} />
      {handOffs.map((h) => (
        <HandOff key={h.url} name={h.name} onShare={() => share(h.url)} />
      ))}
      <MembersFullNote />
      {body}
    </SheetScreen>
  );
}

/** One request: who and their address, its chips (`requestChips`), their note, and the answer. */
function RequestCard({
  request: r,
  roles,
  full,
  onSend,
}: {
  request: JoinRequest;
  /** The roles the approver may give; none chosen at first. */
  roles: readonly OrgRole[];
  /** No one more fits: only denying is left. */
  full: boolean;
  onSend: (url: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const surface = useSurface();
  const chips = requestChips(t, i18n.language, r);
  const toast = useToast();
  const approve = useApproveJoinRequest(orgId);
  const deny = useDenyJoinRequest(orgId);
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const flip = (id: string) => setRoleIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const busy = approve.isPending || deny.isPending;
  // Someone else answered first, or it ran out: said in words, and the list refreshes (the hooks refetch).
  const failed = (e: unknown) => toast({ title: knownErrorText(t, e) ?? t("mobile.app.failed"), icon: "x" });

  // Awaited, not `mutate`'s callbacks: the answered card leaves the list (unmounting) before those would run, and
  // the link a server without email returns must still reach the approver.
  const approveIt = async () => {
    try {
      // Only roles still offered (one may have gone since it was picked).
      const given = roleIds.filter((id) => roles.some((x) => x.id === id));
      const news = approvalNews(await approve.mutateAsync({ id: r.id, roleIds: given }));
      successHaptic();
      if ("send" in news) onSend(news.send);
      else
        toast({
          title:
            news.said === "joined"
              ? t("members.requests.joined", { name: r.name })
              : t("members.requests.invited", { email: r.email }),
        });
    } catch (e) {
      failed(e);
    }
  };
  const denyIt = async () => {
    try {
      await deny.mutateAsync({ id: r.id, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      toast({ title: t("members.requests.denied") });
    } catch (e) {
      failed(e);
    }
  };

  return (
    <View style={[styles.card, surface]}>
      <View
        style={styles.who}
        accessible
        accessibilityLabel={`${t("members.requests.label", { name: r.name })}, ${r.email}`}
      >
        <PersonAvatar name={r.name} size={36} />
        <View style={styles.grow}>
          <Text variant="body" style={styles.bold} numberOfLines={2}>
            {r.name}
          </Text>
          <Text variant="small" tone="muted" numberOfLines={1}>
            {r.email}
          </Text>
        </View>
      </View>
      <View style={styles.chips}>
        {chips.unverified ? <Chip icon="mail" label={chips.unverified} /> : null}
        <Chip icon={r.suggestedBy ? "person" : "clock"} label={chips.asked} />
      </View>
      {/* Their note, in their words. */}
      {r.note ? (
        <Text variant="body" tone="ink">
          {t("members.requests.note", { note: r.note })}
        </Text>
      ) : null}
      {denying ? (
        <>
          <Locked when={busy} style={styles.field}>
            <TextArea
              value={reason}
              onChangeText={setReason}
              placeholder={t("members.requests.reason")}
              accessibilityLabel={t("members.requests.denyTitle", { name: r.name })}
              maxLength={JOIN_REASON_MAX}
              autoFocus
            />
            <Text variant="caption" tone="faint">
              {t("members.requests.reasonHelp")}
            </Text>
          </Locked>
          <View style={styles.acts}>
            <View style={styles.grow}>
              <Button
                variant="primary"
                wide
                label={t("members.requests.deny")}
                loading={deny.isPending}
                disabled={busy}
                onPress={() => void denyIt()}
              />
            </View>
            <View style={styles.grow}>
              <Button
                variant="ghost"
                wide
                label={t("mobile.common.back")}
                disabled={busy}
                onPress={() => setDenying(false)}
              />
            </View>
          </View>
        </>
      ) : (
        <>
          {roles.length > 0 ? (
            <View style={styles.field}>
              <InfoHint
                name={t("common.about", { label: t("mobile.joinRequests.roles") })}
                text={t("mobile.joinRequests.rolesHint")}
                variant="footnote"
              >
                <Text variant="footnote" tone="muted">
                  {t("mobile.joinRequests.roles")}
                </Text>
              </InfoHint>
              <GroupedList>
                {roles.map((role) => (
                  <GroupedRow
                    key={role.id}
                    label={role.name}
                    toggle={roleIds.includes(role.id)}
                    disabled={busy}
                    onPress={() => flip(role.id)}
                  />
                ))}
              </GroupedList>
            </View>
          ) : null}
          <View style={styles.acts}>
            <View style={styles.grow}>
              <Button
                variant="primary"
                wide
                icon="check"
                label={t("members.requests.approve")}
                loading={approve.isPending}
                disabled={busy || full}
                onPress={() => void approveIt()}
              />
            </View>
            <View style={styles.grow}>
              <Button
                variant="secondary"
                wide
                label={t("members.requests.deny")}
                disabled={busy}
                onPress={() => setDenying(true)}
              />
            </View>
          </View>
        </>
      )}
    </View>
  );
}

/** A server that sends no email: an approved person's invitation link, to share with them. */
function HandOff({ name, onShare }: { name: string; onShare: () => void }) {
  const { t } = useTranslation();
  const surface = useSurface();
  return (
    <View style={[styles.card, surface]}>
      <Text variant="title">{t("members.requests.copyTitle", { name })}</Text>
      <Text variant="small" tone="muted">
        {t("members.requests.copyText", { name })}
      </Text>
      <Button variant="primary" wide icon="share" label={t("mobile.joinRequests.share")} onPress={onShare} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 22, paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
  who: { flexDirection: "row", alignItems: "center", gap: 10 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  field: { gap: 6 },
  acts: { flexDirection: "row", gap: 8 },
});
