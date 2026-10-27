import { type JoinRequest, useApproveJoinRequest, useDenyJoinRequest, useJoinRequests } from "@agenteschat/client";
import { knownErrorText } from "@agenteschat/client/lib/errors";
import { APPROVE_ROLES, type ApproveRole, approvalNews, JOIN_REASON_MAX } from "@agenteschat/client/lib/join-requests";
import { can } from "@agenteschat/client/lib/permissions";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Share, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, InfoHint, LineIcon, PersonAvatar, Segmented, SheetScreen, Text, useToast } from "@/ui";
import { useColors } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { successHaptic, useSurface } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { requestTimes } from "./logic";

/**
 * Requests to join through the invitation link (ADR 0068), as a native form sheet: the web's Members › Requests on
 * the phone, opened by the push, Atividade's card and `agenteschat://join-requests`. Each is approved with a role or
 * denied with a reason the person reads in the email. On a server that sends no email, approving hands the admin
 * the invitation's link to share.
 */
export function JoinRequestsSheet({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const c = useColors();
  const allowed = can(org?.role, "manage_members");
  const list = useJoinRequests(orgId, allowed);
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
    body = list.data.map((r) => (
      <RequestCard
        key={r.id}
        request={r}
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
      {body}
    </SheetScreen>
  );
}

/** One request: who, their address and whether it is proven, their note, and the answer. */
function RequestCard({ request: r, onSend }: { request: JoinRequest; onSend: (url: string) => void }) {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const c = useColors();
  const surface = useSurface();
  const toast = useToast();
  const approve = useApproveJoinRequest(orgId);
  const deny = useDenyJoinRequest(orgId);
  const [role, setRole] = useState<ApproveRole>("member");
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const busy = approve.isPending || deny.isPending;
  // Someone else answered first, or it ran out: said in words, and the list refreshes (the hooks refetch).
  const failed = (e: unknown) => toast({ title: knownErrorText(t, e) ?? t("mobile.app.failed"), icon: "x" });

  // Awaited, not `mutate`'s callbacks: the answered card leaves the list (unmounting) before those would run, and
  // the link a server without email returns must still reach the admin.
  const approveIt = async () => {
    try {
      const news = approvalNews(await approve.mutateAsync({ id: r.id, role }));
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
      {/* The detail in a sunken well, as the web's request card: the address's proof and the two times. */}
      <View style={[styles.well, { backgroundColor: c.sunken }]}>
        <View style={styles.line}>
          <LineIcon
            name={r.confirmed ? "check" : "mail"}
            size={14}
            color={r.confirmed ? c.ok : c.muted}
            variant="small"
          />
          <Text variant="small" tone="ink" style={styles.grow}>
            {r.confirmed ? t("members.requests.confirmed") : t("members.requests.unconfirmed")}
          </Text>
        </View>
        {requestTimes(t, i18n.language, r).map((line) => (
          <Text key={line} variant="caption" tone="muted">
            {line}
          </Text>
        ))}
      </View>
      {/* Their note, in their words, after the detail. */}
      {r.note ? (
        <Text variant="body" tone="ink">
          {t("members.requests.note", { note: r.note })}
        </Text>
      ) : null}
      {denying ? (
        <>
          <View style={styles.field}>
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
          </View>
          <View style={styles.acts}>
            <View style={styles.grow}>
              <Button
                variant="primary"
                wide
                label={t("members.requests.deny")}
                disabled={busy}
                onPress={() => void denyIt()}
              />
            </View>
            <View style={styles.grow}>
              <Button variant="ghost" wide label={t("mobile.common.back")} onPress={() => setDenying(false)} />
            </View>
          </View>
        </>
      ) : (
        <>
          <InfoHint name={t("common.about", { label: t("members.role") })} text={t("mobile.joinRequests.rolesHint")}>
            <Segmented
              items={APPROVE_ROLES.map((key) => ({ key, label: t(`roles.${key}`) }))}
              value={role}
              onChange={(key) => setRole(key === "admin" ? "admin" : "member")}
            />
          </InfoHint>
          <View style={styles.acts}>
            <View style={styles.grow}>
              <Button
                variant="primary"
                wide
                icon="check"
                label={t("members.requests.approve")}
                disabled={busy}
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
  line: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  well: { gap: 4, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  field: { gap: 6 },
  acts: { flexDirection: "row", gap: 8 },
});
