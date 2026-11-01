import { useUpdateAgent } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { ROLE_MAX } from "@agenteschat/client/lib/new-agent";
import { can } from "@agenteschat/client/lib/permissions";
import { router, usePreventRemove } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, StyleSheet, TextInput, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useOrg } from "@/providers/org";
import { AgentAvatar, CharCount, EmptyState, fieldText, GroupedList, GroupedRow, Text, useToast } from "@/ui";
import { useFailed } from "../routines/hooks";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { PushedHeader, successHaptic } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { openAgentDelete } from "./DeleteAgentScreen";
import { type AgentDraft, agentChanges, editableFields, fullLook } from "./edit";
import { LookPicker } from "./LookPicker";

/** Opens "Editar" for an agent. */
export const openAgentEdit = (id: string) => router.push({ pathname: "/agent-edit", params: { id } });

/**
 * "Editar agente", as the web's Configurações › Identidade and Instruções: name, role, look and
 * instructions for admins; the look only for the agent's own person (the server's rules). One Salvar.
 */
export function AgentEditScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const failed = useFailed();
  const dir = useDirectory();
  const meId = useMeId();
  const org = useOrg().org;
  const agent = dir.agentById.get(id);
  const update = useUpdateAgent(useOrgId(), id);
  const admin = can(org, "manage_agents");
  const fields = editableFields({
    admin,
    owner: Boolean(meId && agent?.ownerUserId === meId),
  });
  const saved = useMemo<AgentDraft | null>(
    () =>
      agent
        ? { name: agent.name, role: agent.role, instructions: agent.instructions, look: fullLook(agent.appearance) }
        : null,
    [agent],
  );
  const [edits, setEdits] = useState<Partial<AgentDraft>>({});
  const draft = saved ? { ...saved, ...edits } : null;
  const changes = saved && draft ? agentChanges(saved, draft, fields) : null;
  const nameMissing = Boolean(draft && fields.has("name") && !draft.name.trim());
  const done = useRef(false);

  // Leaving with changes asks first (as writing a wiki page).
  usePreventRemove(Boolean(changes), ({ repeat }) => {
    if (done.current) return repeat();
    Alert.alert(t("mobile.agentEdit.discardTitle"), t("mobile.agentEdit.discardText"), [
      { text: t("mobile.agentEdit.keepEditing"), style: "cancel" },
      { text: t("mobile.agentEdit.discard"), style: "destructive", onPress: repeat },
    ]);
  });

  if (!agent || !draft) {
    return (
      <View style={[styles.fill, { backgroundColor: c.bg }]}>
        <PushedHeader title={t("agent.edit")} solid={false} />
        <EmptyState icon="agent" title={t("mobile.agentEdit.missing")} />
      </View>
    );
  }

  const set = <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) => setEdits((e) => ({ ...e, [key]: value }));
  const save = () => {
    if (!changes || nameMissing || update.isPending) return;
    update.mutate(changes, {
      onSuccess: () => {
        done.current = true;
        successHaptic();
        toast({ title: t("mobile.agentEdit.saved"), agentId: id });
        router.back();
      },
      onError: failed,
    });
  };
  const field = [styles.field, fieldText("body"), { backgroundColor: c.raised, color: c.ink, borderColor: c.line }];
  const readOnly = (label: string, value: string) => (
    <>
      <Text variant="footnote" tone="faint">
        {label}
      </Text>
      <Text variant="body" tone="ink2">
        {value || t("agentPage.none")}
      </Text>
    </>
  );

  return (
    <View style={[styles.fill, { backgroundColor: c.bg }]}>
      <PushedHeader
        title={t("agent.edit")}
        solid={false}
        action={{ label: t("common.save"), onPress: save, disabled: !changes || nameMissing || update.isPending }}
      />
      <KeyboardAwareScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        bottomOffset={24}
        contentContainerStyle={styles.form}
      >
        <View style={styles.hero}>
          <AgentAvatar agent={{ ...draft.look, id }} size={96} name={draft.name} />
          <Text variant="footnote" tone="muted">
            @{agent.handle}
          </Text>
        </View>

        {fields.has("name") ? (
          <>
            <Text variant="footnote" tone="faint">
              {t("agent.nameLabel")}
            </Text>
            <TextInput
              value={draft.name}
              onChangeText={(v) => set("name", v)}
              maxLength={32}
              autoCorrect={false}
              placeholder={t("newAgent.namePlaceholder")}
              placeholderTextColor={c.faint}
              accessibilityLabel={t("agent.nameLabel")}
              style={field}
            />
            <Text variant="footnote" tone="faint">
              {nameMissing ? t("newAgent.errors.nameRequired") : t("agent.identityHelp", { handle: agent.handle })}
            </Text>
          </>
        ) : (
          readOnly(t("agent.nameLabel"), agent.name)
        )}

        {fields.has("role") ? (
          <>
            <View style={[styles.labelRow, styles.gapTop]}>
              <Text variant="footnote" tone="faint">
                {t("agent.roleLabel")}
              </Text>
              <CharCount
                count={draft.role.length}
                max={ROLE_MAX}
                label={t("newAgent.roleCount", { count: draft.role.length, max: ROLE_MAX })}
              />
            </View>
            {/* A longer one saved before the limit stays as it is until it's edited (it shows past the count). */}
            <TextInput
              value={draft.role}
              onChangeText={(v) => set("role", v)}
              maxLength={ROLE_MAX}
              placeholder={t("mobile.agentEdit.rolePlaceholder")}
              placeholderTextColor={c.faint}
              accessibilityLabel={t("agent.roleLabel")}
              style={field}
            />
          </>
        ) : (
          <View style={styles.gapTop}>{readOnly(t("agent.roleLabel"), agent.role)}</View>
        )}

        {fields.has("look") ? (
          <View style={styles.section}>
            <Text variant="title" accessibilityRole="header">
              {t("newAgent.look")}
            </Text>
            <LookPicker look={draft.look} onChange={(look) => set("look", look)} />
          </View>
        ) : null}

        <View style={styles.section}>
          <Text variant="title" accessibilityRole="header">
            {t("agent.instructions")}
          </Text>
          {fields.has("instructions") ? (
            <TextArea
              value={draft.instructions}
              onChangeText={(v) => set("instructions", v)}
              placeholder={t("newAgent.instructionsPlaceholder")}
              accessibilityLabel={t("agent.instructions")}
              minHeight={180}
              scrollEnabled={false}
            />
          ) : (
            <Text variant="body" tone="ink2" selectable>
              {agent.instructions || t("agentPage.none")}
            </Text>
          )}
          {!fields.has("name") ? (
            <Text variant="footnote" tone="faint">
              {t("mobile.agentEdit.adminsOnly")}
            </Text>
          ) : null}
        </View>

        {/* Deleting for good asks for its name on a screen of its own (ADR 0082). */}
        {admin ? (
          <View style={styles.section}>
            <GroupedList>
              <GroupedRow
                icon="x"
                label={t("agentPage.delete.action", agentGrammar(t, agent.name))}
                sub={t("agentPage.delete.help")}
                subLines={2}
                danger
                chevron
                onPress={() => openAgentDelete(id)}
              />
            </GroupedList>
          </View>
        ) : null}
      </KeyboardAwareScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  form: { paddingHorizontal: 18, paddingBottom: 48, gap: 8 },
  hero: { alignItems: "center", gap: 6, paddingVertical: 12 },
  field: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 12 },
  gapTop: { marginTop: 10, gap: 8 },
  labelRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  section: { marginTop: 22, gap: 10 },
});
