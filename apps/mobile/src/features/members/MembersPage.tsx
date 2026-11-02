import {
  type InvitationWithStatus,
  type Person,
  useAllInvitations,
  useCancelSuggestion,
  useJoinRequests,
  useMe,
  useMySuggestions,
  usePeople,
  useRemoveMember,
  useRoles,
} from "@agenteschat/client";
import { knownErrorText } from "@agenteschat/client/lib/errors";
import { namesText } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { removesMember } from "@agenteschat/client/lib/roles";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, PersonAvatar, useToast } from "@/ui";
import { Page } from "../me/parts";
import { Face } from "../shared/Face";
import { useColors, useMeId } from "../shared/hooks";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { InvitationSheet } from "./InviteSheets";
import {
  invitationLine,
  invitationSender,
  invitersOf,
  memberLine,
  membersByName,
  pendingInvitations,
  waitingLine,
  whenWords,
} from "./logic";
import { MembersFullNote } from "./MembersFullNote";

/**
 * Membros e convites (ADR 0090), one page: whoever may invite gets "Convidar pessoas" on top (the workspace's link
 * lives on that screen), then what waits on them and the invitations sent; a member who may not invite suggests
 * someone. Then the people, each with their roles (ADR 0085).
 */
export function MembersPage() {
  return (
    <SheetHostProvider>
      <Members />
    </SheetHostProvider>
  );
}

function Members() {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const c = useColors();
  const meId = useMeId();
  const people = usePeople(orgId);
  const roles = useRoles(orgId).data?.roles ?? [];
  const invites = can(org, "invite_people");
  const list = people.data;
  const toast = useToast();
  const remove = useRemoveMember(orgId);
  const viewer = { role: org?.role ?? "member", rank: org?.rank, userId: meId ?? "", permissions: org?.permissions };
  const orgName = org?.name ?? "";

  // "Remover do workspace": confirmed first; the server checks again and its refusal is said in our words.
  const confirmRemove = (m: Person) =>
    Alert.alert(t("members.remove.title", { name: m.name, org: orgName }), t("members.remove.body", { org: orgName }), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("members.remove.confirm"),
        style: "destructive",
        onPress: () =>
          remove.mutate(m.userId, {
            onSuccess: () => toast({ title: t("members.remove.done", { name: m.name, org: orgName }) }),
            onError: (e) => toast({ title: knownErrorText(t, e, i18n.language) ?? t("mobile.app.failed"), icon: "x" }),
          }),
      },
    ]);

  return (
    <Page title={invites ? t("settings.section.members") : t("members.title")}>
      <View style={styles.gap} />
      {invites ? (
        <>
          <GroupedList>
            <GroupedRow icon="plus" label={t("members.inviteTitle")} onPress={() => router.push("/invite-people")} />
          </GroupedList>
          <WaitingYou />
          <SentInvitations />
        </>
      ) : (
        <Suggestions />
      )}

      <GroupedHeader>{list ? `${t("members.people")} · ${list.length}` : t("members.people")}</GroupedHeader>
      {list ? (
        <GroupedList>
          {membersByName(list, i18n.language).map((m) => (
            <GroupedRow
              key={m.userId}
              leading={<Face who={{ type: "person", id: m.userId }} size={30} live={false} presence ring={c.raised} />}
              label={m.userId === meId ? `${m.name}${t("common.youSuffix")}` : m.name}
              sub={memberLine(t, i18n.language, m, roles)}
              {...(meId && removesMember(viewer, m, roles)
                ? { more: true, disabled: remove.isPending, onPress: () => confirmRemove(m) }
                : {})}
            />
          ))}
        </GroupedList>
      ) : (
        <ActivityIndicator color={c.muted} style={styles.loading} />
      )}
    </Page>
  );
}

/** Esperando você: who asked through the link and whom members suggested, each opening the review (ADR 0068, 0090). */
function WaitingYou() {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const requests = useJoinRequests(orgId).data ?? [];
  if (requests.length === 0) return null;
  return (
    <>
      <GroupedHeader>{`${t("members.waitingTitle")} · ${requests.length}`}</GroupedHeader>
      <GroupedList>
        {requests.map((r) => (
          <GroupedRow
            key={r.id}
            leading={<PersonAvatar name={r.name} size={30} />}
            label={r.name}
            sub={waitingLine(t, i18n.language, r)}
            subLines={2}
            chevron
            onPress={() => router.push({ pathname: "/join-requests", params: { request: r.id } })}
          />
        ))}
      </GroupedList>
      <MembersFullNote />
    </>
  );
}

/** Convites enviados: those still waiting, each opening its actions (ADR 0090). */
function SentInvitations() {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const sheet = useSheet();
  const me = useMe().data?.user.name;
  const list = pendingInvitations(useAllInvitations(orgId).data ?? []);
  const roles = useRoles(orgId).data?.roles ?? [];
  // Sent again from here: until when it works now.
  const [resent, setResent] = useState<Record<string, string>>({});
  if (list.length === 0) return null;
  const open = (inv: InvitationWithStatus) =>
    sheet.open(
      <InvitationSheet
        invitation={inv}
        line={invitationLine(t, i18n.language, inv, roles, {
          resentUntil: resent[inv.id],
          sender: invitationSender(t, inv, me),
        })}
        resent={Boolean(resent[inv.id])}
        onResent={(id, until) => setResent((all) => ({ ...all, [id]: until }))}
      />,
      { solid: true },
    );
  return (
    <>
      <GroupedHeader>{`${t("members.invitations.title")} · ${list.length}`}</GroupedHeader>
      <GroupedList>
        {list.map((inv) => (
          <GroupedRow
            key={inv.id}
            leading={<PersonAvatar name={inv.email} size={30} />}
            label={inv.email}
            sub={invitationLine(t, i18n.language, inv, roles, { resentUntil: resent[inv.id] })}
            more
            onPress={() => open(inv)}
          />
        ))}
      </GroupedList>
    </>
  );
}

/**
 * A member who may not invite (ADR 0090 §7): "Sugerir pessoa", which reaches the people who invite as a request, who
 * they are, and the suggestions still waiting, each to take back.
 */
function Suggestions() {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const toast = useToast();
  const people = usePeople(orgId).data ?? [];
  const roles = useRoles(orgId).data?.roles ?? [];
  const waiting = useMySuggestions(orgId).data ?? [];
  const cancel = useCancelSuggestion(orgId);
  const inviters = invitersOf(people, roles);

  const cancelIt = async (id: string) => {
    try {
      await cancel.mutateAsync(id);
      toast({ title: t("members.suggest.cancelled") });
    } catch (e) {
      toast({ title: knownErrorText(t, e, i18n.language) ?? t("mobile.app.failed"), icon: "x" });
    }
  };
  const confirmCancel = (id: string, email: string) =>
    Alert.alert(t("members.suggest.cancelOf", { email }), undefined, [
      { text: t("mobile.common.back"), style: "cancel" },
      { text: t("common.cancel"), style: "destructive", onPress: () => void cancelIt(id) },
    ]);

  return (
    <>
      <GroupedList>
        <GroupedRow icon="plus" label={t("members.suggest.button")} onPress={() => router.push("/suggest-person")} />
      </GroupedList>
      <GroupedFooter>
        {inviters.length > 0
          ? t("members.suggest.lead", { count: inviters.length, names: namesText(t, inviters, 2) })
          : t("members.suggest.leadNoNames")}
      </GroupedFooter>
      {waiting.length > 0 ? (
        <>
          <GroupedHeader>{t("members.suggest.mine")}</GroupedHeader>
          <GroupedList>
            {waiting.map((s) => (
              <GroupedRow
                key={s.id}
                leading={<PersonAvatar name={s.email} size={30} />}
                label={s.email}
                sub={t("members.suggest.waiting", { when: whenWords(t, i18n.language, s.createdAt) })}
                {...(s.note ? { belowText: s.note } : {})}
                more
                disabled={cancel.isPending}
                onPress={() => confirmCancel(s.id, s.email)}
              />
            ))}
          </GroupedList>
        </>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  gap: { height: 14 },
  loading: { marginVertical: 16 },
});
