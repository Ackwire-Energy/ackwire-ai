import { type Me, useApi } from "@agenteschat/client";
import { workspaceNotes } from "@agenteschat/client/lib/deletion";
import { CLOUD_SERVER, checkServer, normalizeServer, serverHost } from "@agenteschat/client/lib/server";
import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { openWorkspace, problemText } from "@/features/server";
import { createApi } from "@/lib/api";
import { askNewWorkspace } from "@/lib/new-workspace";
import { openOrgs } from "@/lib/org-choice";
import { ALLOW_HTTP, serverUrl, signedInServers, useServer, useSignedInServers } from "@/lib/server";
import { useOrg, useOrgMaybe } from "@/providers/org";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, haptics, Locked, SheetScreen, useToast } from "@/ui";
import { AuthField } from "@/ui/auth/AuthField";
import { Button } from "@/ui/Button";
import { router } from "@/ui/navigation";
import { Text } from "@/ui/Text";
import { OrgAvatar } from "../shared/OrgAvatar";
import { goBack } from "../shared/parts";
import { Page } from "./parts";
import { orderedServers, type ServerWorkspaces, unreadElsewhere, workspacesOf } from "./workspaces-logic";

/** How long a server's list stays fresh: each one is asked again after this when Workspaces opens. */
const FRESH_MS = 30_000;

/**
 * Every workspace of every server this phone is signed in to (ADR 0154), grouped by server, each with its unread
 * count: the current server from its own `me`, the others with their own sessions. A server that doesn't answer
 * keeps its group, saying so.
 */
export function useWorkspacesAcross(): { groups: ServerWorkspaces[]; elsewhere: number } {
  const server = useServer();
  const signedIn = useSignedInServers();
  const org = useOrgMaybe();
  const api = useApi();
  const servers = orderedServers(signedIn, server);
  const results = useQueries({
    queries: servers.map((s) => ({
      queryKey: ["workspaces-across", s] as const,
      staleTime: FRESH_MS,
      queryFn: async (): Promise<{ me: Me | null; unread: { orgId: string; unread: number }[] }> => {
        const client = s === server ? api : createApi(s);
        const [me, unread] = await Promise.all([client.account.me(), client.account.unread().catch(() => null)]);
        return { me, unread: unread?.organizations ?? [] };
      },
    })),
  });
  const groups = servers.map((s, i) => {
    const r = results[i];
    const me = s === server && org ? { organizations: org.orgs } : (r?.data?.me ?? null);
    return workspacesOf({
      server: s,
      current: s === server,
      orgs: openOrgs(me?.organizations ?? []),
      unread: r?.data?.unread ?? [],
      failed: Boolean(r?.isError) && !r?.data,
    });
  });
  return { groups, elsewhere: unreadElsewhere(groups, org?.orgId ?? null) };
}

/**
 * Opens a workspace from a list of them: the current server's by choosing it; another server's by moving there, the
 * toast saying where you are now ("Agora em …", on the axis it came from; nothing signs out, ADR 0154). `before`:
 * closes the list first (a sheet), so the move is seen on the screen under it.
 */
export function useOpenWorkspaceRow(before?: () => void) {
  const { t } = useTranslation();
  const toast = useToast();
  const org = useOrg();
  return (g: ServerWorkspaces, o: { id: string; name: string }) => {
    const here = g.current && o.id === org.orgId;
    if (here) return;
    haptics.light();
    before?.();
    if (g.current) {
      org.setOrgId(o.id);
      router.dismissTo("/");
      return;
    }
    toast({ title: t("mobile.auth.server.now", { host: o.name }) });
    void openWorkspace(g.server, o.id);
  };
}

/**
 * The groups of workspaces, one per server (its host as the small header), each workspace with its own mark (logo,
 * or its initial), its role, the check on the current one and the unread count on the others; a server that didn't
 * answer stays in its place, faded. Shared by the page and the sheet.
 */
export function WorkspaceGroups({ groups, onOpen }: { groups: ServerWorkspaces[]; onOpen: ReturnType<typeof useOpenWorkspaceRow> }) {
  const { t, i18n } = useTranslation();
  const org = useOrg();
  return (
    <>
      {groups.map((g) => {
        const notes = workspaceNotes(t, i18n.language, g.orgs);
        return (
          <View key={g.server}>
            <GroupedHeader>{g.host}</GroupedHeader>
            <GroupedList>
              {g.failed ? (
                <GroupedRow icon="wifi" label={t("mobile.me.workspacesUnreachable")} faint />
              ) : (
                g.orgs.map((o) => {
                  const here = g.current && o.id === org.orgId;
                  return (
                    <GroupedRow
                      key={o.id}
                      leading={<OrgAvatar logo={o.logo} name={o.name} server={g.server} />}
                      label={o.name}
                      sub={notes.get(o.id) ?? t(`mobile.me.role.${o.role}`)}
                      checked={here}
                      {...(!here && o.unread > 0 ? { value: String(o.unread) } : {})}
                      onPress={() => onOpen(g, o)}
                    />
                  );
                })
              )}
            </GroupedList>
          </View>
        );
      })}
    </>
  );
}

/** Workspaces: every server's, under a header each; tapping one opens it, on its server, without signing out. */
export function WorkspacesPage() {
  const { t } = useTranslation();
  const { groups } = useWorkspacesAcross();
  const open = useOpenWorkspaceRow();
  return (
    <Page title={t("mobile.me.workspaces")}>
      <WorkspaceGroups groups={groups} onOpen={open} />
      <View style={styles.gap} />
      <GroupedList>
        <GroupedRow
          icon="plus"
          label={t("mobile.me.addWorkspace")}
          chevron
          onPress={() => router.push("/me/add-workspace")}
        />
      </GroupedList>
      <GroupedFooter>{t("mobile.me.workspacesFoot")}</GroupedFooter>
    </Page>
  );
}

/**
 * Adicionar workspace, a short sheet (the system's form sheet, sized to its two rows): a new one on agentes.chat,
 * or the team's own server; one line under them says nothing is lost.
 */
export function AddWorkspacePage() {
  const { t } = useTranslation();
  const create = () => {
    askNewWorkspace(CLOUD_SERVER);
    // Signed in to agentes.chat already: its first run opens over the app; otherwise its sign-in comes first.
    if (serverUrl() === CLOUD_SERVER) router.dismissTo("/");
    else void openWorkspace(CLOUD_SERVER, null);
  };
  return (
    <SheetScreen fit>
      <Text variant="title2" accessibilityRole="header" style={styles.sheetTitle}>
        {t("mobile.me.addWorkspace")}
      </Text>
      <GroupedList>
        <GroupedRow
          icon="plus"
          label={t("mobile.me.addWorkspaceCreate")}
          sub={t("mobile.me.addWorkspaceCreateSub")}
          chevron
          onPress={create}
        />
        <GroupedRow
          icon="server"
          label={t("mobile.me.addWorkspaceTeamShort")}
          sub={t("mobile.me.addWorkspaceTeamSubShort")}
          chevron
          onPress={() => {
            goBack();
            router.push("/me/team-server");
          }}
        />
      </GroupedList>
      <GroupedFooter>{t("mobile.me.addWorkspaceFoot")}</GroupedFooter>
    </SheetScreen>
  );
}

/**
 * Servidor da equipe, while signed in: the question, the address with the URL keyboard open and its return key as the
 * action, Escanear QR code below it, and one quiet line: nothing signs out (ADR 0154). The server is checked first;
 * then the app moves there: signed in there already, its workspaces; otherwise its sign-in.
 */
export function TeamServerPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy || !address.trim()) return;
    const server = normalizeServer(address, { allowHttp: ALLOW_HTTP });
    if (!server) return setError(t("mobile.auth.server.invalid"));
    setBusy(true);
    setError(null);
    const check = await checkServer(server);
    if (!check.ok) {
      haptics.warning();
      setError(t(problemText(check.problem, check.server), { host: serverHost(check.server) }));
      return setBusy(false);
    }
    if (signedInServers().includes(check.server))
      toast({ title: t("mobile.auth.server.now", { host: serverHost(check.server) }) });
    await openWorkspace(check.server, null);
  };

  return (
    <Page title={t("mobile.me.teamServer")}>
      <Text variant="subhead" tone="muted" style={styles.lead}>
        {t("mobile.me.teamServerLeadShort")}
      </Text>
      <View style={styles.form}>
        <Locked when={busy} keepKeyboard>
          <AuthField
            value={address}
            onChangeText={(value) => {
              setAddress(value);
              setError(null);
            }}
            placeholder={t("mobile.auth.server.placeholder")}
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="URL"
            returnKeyType="go"
            enablesReturnKeyAutomatically
            onSubmitEditing={() => void submit()}
            accessibilityLabel={t("mobile.auth.server.label")}
            autoFocus
          />
        </Locked>
        {error ? (
          <Text tone="danger" variant="small" style={styles.center}>
            {error}
          </Text>
        ) : null}
        <Button
          variant="primary"
          wide
          label={busy ? t("mobile.auth.server.checking") : t("mobile.auth.server.use")}
          loading={busy}
          disabled={!address.trim()}
          onPress={() => void submit()}
        />
        <Button
          variant="secondary"
          wide
          icon="camera"
          label={t("mobile.auth.server.scan")}
          disabled={busy}
          onPress={() => router.push("/me/scan")}
        />
        <Text variant="footnote" tone="muted" style={[styles.center, styles.quiet]}>
          {t("mobile.me.addWorkspaceFoot")}
        </Text>
      </View>
    </Page>
  );
}

const styles = StyleSheet.create({
  gap: { height: 22 },
  sheetTitle: { paddingHorizontal: 4, paddingBottom: 12 },
  lead: { paddingHorizontal: 4, paddingTop: 4 },
  form: { gap: 8, paddingTop: 16 },
  center: { textAlign: "center" },
  quiet: { paddingTop: 8 },
});
