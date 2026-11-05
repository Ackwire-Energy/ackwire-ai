import { useUpdateAgent } from "@agenteschat/client";
import { audienceOf, consultableLocked, offersConsultable } from "@agenteschat/client/lib/audience";
import { engineOfBrain } from "@agenteschat/client/lib/brain";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { cleanHandle, handleAfterRename, handleProblemText, takenHandles } from "@agenteschat/client/lib/new-agent";
import { can } from "@agenteschat/client/lib/permissions";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { router, usePreventRemove } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, StyleSheet, TextInput, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useOrg } from "@/providers/org";
import { AgentAvatar, EmptyState, fieldText, GroupedList, GroupedRow, Locked, Text, useToast } from "@/ui";
import { useWidenAsk } from "../chat/ReachLines";
import { useFailed } from "../routines/hooks";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { PushedHeader, successHaptic } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { BrakesSection } from "./BrakesSection";
import { BudgetSection } from "./BudgetSection";
import { openAgentDelete } from "./DeleteAgentScreen";
import { type AgentDraft, agentChanges, editableFields, fullLook } from "./edit";
import { ErrorLine, HandleInput } from "./HandleInput";
import { LookPicker } from "./LookPicker";
import { RoleInput } from "./RoleInput";

/** Opens "Editar" for an agent. */
export const openAgentEdit = (id: string) => router.push({ pathname: "/agent-edit", params: { id } });

/**
 * "Editar agente", as the web's Configurações › Identidade and Instruções: name, its @ (Menções, which follows a
 * new name until typed), role, look and instructions for admins; the look only for
 * the agent's own person (the server's rules). One Salvar. The team's right hand (ADR 0137) is its name, @ and look
 * only: its instructions are the product's, and it is never archived or deleted.
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
  const ask = useWidenAsk(agent);
  const admin = can(org, "manage_agents");
  const rightHand = isRightHand(agent);
  const owner = Boolean(meId && agent?.ownerUserId === meId);
  const fields = editableFields({ admin, owner });
  const onPlan = engineOfBrain(agent?.brain?.kind) !== "agent";
  const saved = useMemo<AgentDraft | null>(
    () =>
      agent
        ? {
            name: agent.name,
            handle: agent.handle,
            role: agent.role,
            instructions: agent.instructions,
            look: fullLook(agent.appearance),
            audience: audienceOf(agent),
          }
        : null,
    [agent],
  );
  const [edits, setEdits] = useState<Partial<AgentDraft>>({});
  const draft = saved
    ? { ...saved, ...edits, handle: handleAfterRename(saved, edits.name ?? saved.name, edits.handle) }
    : null;
  const changes = saved && draft ? agentChanges(saved, draft, fields) : null;
  const nameMissing = Boolean(draft && fields.has("name") && !draft.name.trim());
  const taken = useMemo(
    () => takenHandles(dir.agents, [...dir.memberById.values()], id),
    [dir.agents, dir.memberById, id],
  );
  const moved = Boolean(saved && draft && draft.handle !== saved.handle);
  const handleIssue = moved && draft ? handleProblemText(t, draft.handle, taken) : null;
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
  const save = async () => {
    if (!changes || nameMissing || handleIssue || update.isPending) return;
    if (changes.audience && !(await ask(changes.audience)([]))) return;
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
        action={{
          label: t("common.save"),
          onPress: () => void save(),
          disabled: !changes || nameMissing || Boolean(handleIssue) || update.isPending,
        }}
      />
      <KeyboardAwareScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        bottomOffset={24}
        contentContainerStyle={styles.form}
      >
        <Locked when={update.isPending} style={styles.fields}>
          <View style={styles.hero}>
            <AgentAvatar agent={{ ...draft.look, id }} size={96} name={draft.name} />
            <Text variant="footnote" tone="muted">
              @{draft.handle}
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
                {nameMissing
                  ? t("newAgent.errors.nameRequired")
                  : moved && !handleIssue
                    ? t("agent.handleMoves", { handle: draft.handle, old: agent.handle })
                    : t("agent.identityHelp")}
              </Text>
              <Text variant="footnote" tone="faint" style={styles.gapTop}>
                {t("agent.handleLabel")}
              </Text>
              <HandleInput
                value={draft.handle}
                onChangeText={(v) => set("handle", cleanHandle(v))}
                label={t("agent.handleLabel")}
              />
              {handleIssue ? <ErrorLine text={handleIssue} /> : null}
            </>
          ) : (
            readOnly(t("agent.nameLabel"), agent.name)
          )}

          {rightHand ? null : fields.has("role") ? (
            <RoleInput value={draft.role} onChangeText={(v) => set("role", v)} placeholder={t("agent.roleHelp")} />
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

          {/* Only an audience that leaves someone out has anyone to be consulted for. */}
          {!rightHand && offersConsultable(draft.audience, onPlan) ? (
            <View style={styles.section}>
              <GroupedList>
                <GroupedRow
                  icon="agent"
                  label={t("audience.consultable", agentGrammar(agent.name))}
                  labelLines={2}
                  sub={t("audience.consultableHint", agentGrammar(agent.name))}
                  subLines={4}
                  toggle={draft.audience.consultable !== false}
                  disabled={
                    !fields.has("consultable") || (!!saved && consultableLocked(saved.audience, { owner, onPlan }))
                  }
                  onPress={() =>
                    set("audience", { ...draft.audience, consultable: draft.audience.consultable === false })
                  }
                />
              </GroupedList>
            </View>
          ) : null}

          {rightHand ? (
            <Text variant="footnote" tone="faint" style={styles.section}>
              {t("rightHand.settings.lock", agentGrammar(agent.name))}
            </Text>
          ) : (
            <>
              {admin ? <BudgetSection agent={agent} /> : null}
              <BrakesSection agent={agent} />

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
            </>
          )}

          {/* Deleting for good asks for its name on a screen of its own (ADR 0082). */}
          {admin && !rightHand ? (
            <View style={styles.section}>
              <GroupedList>
                <GroupedRow
                  icon="x"
                  label={t("agentPage.delete.action", agentGrammar(agent.name))}
                  sub={t("agentPage.delete.help")}
                  subLines={2}
                  danger
                  chevron
                  onPress={() => openAgentDelete(id)}
                />
              </GroupedList>
            </View>
          ) : null}
        </Locked>
      </KeyboardAwareScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  form: { paddingHorizontal: 18, paddingBottom: 48, gap: 8 },
  fields: { gap: 8 },
  hero: { alignItems: "center", gap: 6, paddingVertical: 12 },
  field: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 12 },
  gapTop: { marginTop: 10, gap: 8 },
  section: { marginTop: 22, gap: 10 },
});
