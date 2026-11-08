import {
  type ToolChange,
  useAcceptConnectionToolChanges,
  useAcceptToolChange,
  useToolChanges,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { can } from "@agenteschat/client/lib/permissions";
import { type ToolChangeDiff, toolChangeDiff, toolChangeSummary } from "@agenteschat/client/lib/tool-changes";
import { diffLines } from "@agenteschat/ui/diff";
import { type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import { Button, DiffView, GroupedFooter, GroupedHeader, GroupedList, GroupedRow, Locked, Text, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { useColors, useOrgId } from "../shared/hooks";
import { errorHaptic, goBack, PushedHeader, successHaptic } from "../shared/parts";

/** Opens one changed tool of a connection: what changed, and Aceitar. */
export const openToolChange = (connectionId: string, toolName: string) =>
  router.push({ pathname: "/connectors/change", params: { id: connectionId, tool: toolName } });

/** The changed tools waiting for this person's review (ADR 0117): connector admins only, the rest see none. */
export function useConnectionToolChanges(connectionId: string) {
  const { org, orgId } = useOrg();
  const changes = useToolChanges(orgId, can(org, "manage_connectors"));
  const mine = useMemo(
    () => (changes.data ?? []).filter((c) => c.connectionId === connectionId),
    [changes.data, connectionId],
  );
  return { changes: mine, loading: changes.isPending && changes.fetchStatus !== "idle" };
}

/**
 * On top of a connection's Ferramentas, while its server changed approved tools (the web's "Ferramentas que mudaram",
 * ADR 0117): the agents keep the approved version until someone accepts the new one. A row per tool says what changed
 * in a few words and opens the change; "Aceitar todas" takes every one at once.
 */
export function ChangedTools({ connectionId, name }: { connectionId: string; name: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const { changes } = useConnectionToolChanges(connectionId);
  const acceptAll = useAcceptConnectionToolChanges(orgId);
  if (changes.length === 0) return null;
  const all = () =>
    acceptAll.mutate(connectionId, {
      onSuccess: () => {
        successHaptic();
        toast({ title: t("connectors.toolChanges.acceptedAll", { name }) });
      },
      onError: (e) => {
        errorHaptic();
        toast({ title: errorText(t, e), icon: "x" });
      },
    });
  // One block: the page's gap goes around it, never between the header and its rows.
  return (
    <View>
      <GroupedHeader>{`${t("connectors.toolChanges.title")} · ${changes.length}`}</GroupedHeader>
      <Locked when={acceptAll.isPending}>
        <GroupedList>
          {changes.map((c) => (
            <ChangeRow key={c.toolName} change={c} />
          ))}
        </GroupedList>
      </Locked>
      <GroupedFooter>{t("connectors.toolChanges.intro")}</GroupedFooter>
      {changes.length > 1 ? (
        <View style={styles.all}>
          {/* Secondary: the screen's one primary is Salvar, pinned at its bottom. */}
          <Button
            variant="secondary"
            wide
            label={t("connectors.toolChanges.acceptAll")}
            loading={acceptAll.isPending}
            onPress={all}
          />
        </View>
      ) : null}
    </View>
  );
}

/** A changed tool: its name, what changed in a few words; a tap opens the change, where it is accepted. */
function ChangeRow({ change }: { change: ToolChange }) {
  const { t } = useTranslation();
  const diff = useMemo(() => toolChangeDiff(change, diffLines), [change]);
  return (
    <GroupedRow
      label={change.toolName}
      sub={toolChangeSummary(t, diff)}
      chevron
      onPress={() => openToolChange(change.connectionId, change.toolName)}
    />
  );
}

/**
 * One changed tool, pushed over Ferramentas: only the changed sentences of its text, each changed field and its input,
 * as the web's "Ver a mudança" shows them; Aceitar pinned at the bottom, which takes the new version and goes back.
 */
export function ToolChangeScreen({ connectionId, toolName }: { connectionId: string; toolName: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const orgId = useOrgId();
  const toast = useToast();
  const accept = useAcceptToolChange(orgId);
  const { changes, loading } = useConnectionToolChanges(connectionId);
  const change = changes.find((x) => x.toolName === toolName) ?? null;
  const diff = useMemo(() => (change ? toolChangeDiff(change, diffLines) : null), [change]);
  const take = () => {
    if (!change) return;
    accept.mutate(change, {
      onSuccess: () => {
        successHaptic();
        toast({ title: t("connectors.toolChanges.accepted", { tool: toolName }) });
        goBack();
      },
      onError: (e) => {
        errorHaptic();
        toast({ title: errorText(t, e), icon: "x" });
      },
    });
  };
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={toolName} {...(change ? { subtitle: change.connectionLabel } : {})} solid={false} grouped />
      <ScrollView style={styles.screen} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.page}>
        {loading ? (
          <ActivityIndicator color={c.muted} />
        ) : diff ? (
          <ChangeDetails diff={diff} />
        ) : (
          // Accepted meanwhile (here or on the web): nothing of it waits any more.
          <GroupedFooter>{t("toolReview.doneTitle")}</GroupedFooter>
        )}
      </ScrollView>
      {change ? (
        <BottomBar bottom={insets.bottom}>
          <Button
            variant="primary"
            wide
            label={t("connectors.toolChanges.accept")}
            loading={accept.isPending}
            onPress={take}
          />
        </BottomBar>
      ) : null}
    </View>
  );
}

/** What changed, as the web lists it: the text, then each field (its type and whether it is new), then the input. */
function ChangeDetails({ diff }: { diff: ToolChangeDiff }) {
  const { t } = useTranslation();
  return (
    <>
      {diff.description ? (
        <View>
          <GroupedHeader>{t("connectors.toolChanges.description")}</GroupedHeader>
          <DiffView prose lines={diff.description} />
        </View>
      ) : null}
      {diff.fields.length > 0 ? (
        <View style={styles.fields}>
          <GroupedHeader>{t("connectors.toolChanges.input")}</GroupedHeader>
          {diff.fields.map((f) => (
            <View key={f.name} style={styles.field}>
              <Text variant="footnote" tone="muted" style={styles.fieldName}>
                <Text variant="footnote" tone="ink2" style={styles.semibold}>
                  {f.name}
                </Text>
                {[f.type, t(`connectors.toolChanges.field.${f.status}`)]
                  .filter(Boolean)
                  .map((part) => ` · ${part}`)
                  .join("")}
              </Text>
              {f.lines.length > 0 ? <DiffView prose={!f.code} lines={f.lines} /> : null}
            </View>
          ))}
        </View>
      ) : null}
      {diff.schema ? (
        <View>
          {diff.fields.length === 0 ? <GroupedHeader>{t("connectors.toolChanges.input")}</GroupedHeader> : null}
          <DiffView lines={diff.schema} />
        </View>
      ) : null}
    </>
  );
}

/**
 * The screen's one action, pinned at its bottom on the grouped gray, outside the scroll: it never moves with the
 * list, and the list never hides under it.
 */
export function BottomBar({ bottom, children }: { bottom: number; children: ReactNode }) {
  const c = useColors();
  return (
    <View style={[styles.bar, { paddingBottom: bottom + 10, backgroundColor: c.grouped, borderTopColor: c.line2 }]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  // The phone's settings: groups on the grouped gray, 16 pt sides.
  page: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24, gap: 14 },
  all: { paddingTop: 12 },
  fields: { gap: 10 },
  field: { gap: 6 },
  fieldName: { paddingHorizontal: 4 },
  semibold: { fontWeight: "600" },
  bar: { paddingHorizontal: 16, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
});
