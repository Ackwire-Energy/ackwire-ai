import { type Agent, type AgentBrakes, BRAKES_DEFAULTS, useUpdateAgent } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, TextInput, View } from "react-native";
import { useOrg } from "@/providers/org";
import { fieldText, GroupedList, GroupedRow, Text } from "@/ui";
import { useFailed } from "../routines/hooks";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";

const AT_ONCE = [1, 2, 3, 5, 10];
const PRS = [0, 1, 2, 3, 5, 10];

/** The next value of a short list, round: a row's tap steps through it. */
const nextOf = (list: number[], now: number) => list[(list.indexOf(now) + 1) % list.length] ?? list[0] ?? now;

/**
 * The web's Autonomia sem pedido (ADR 0131) on the phone: costly work nobody asked for asks first, how many such jobs
 * at once, PRs an hour, which agents it may call and its project. Saved at once by who manages agents.
 */
export function BrakesSection({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory();
  const c = useColors();
  const failed = useFailed();
  const update = useUpdateAgent(useOrgId(), agent.id);
  const editable = can(org, "manage_agents");
  const saved: AgentBrakes = agent.brakes ?? BRAKES_DEFAULTS;
  const b = { ...saved, ...(update.isPending ? (update.variables?.brakes ?? {}) : {}) };
  const [project, setProject] = useState(b.project);
  useEffect(() => setProject(saved.project), [saved.project]);
  const save = (patch: Partial<AgentBrakes>) => {
    if (editable) update.mutate({ brakes: patch }, { onError: failed });
  };
  const others = [...dir.agentById.values()].filter((a) => !a.former && a.id !== agent.id);
  return (
    <View style={styles.section}>
      <Text variant="title" accessibilityRole="header">
        {t("brakes.title")}
      </Text>
      <Text variant="footnote" tone="faint">
        {t("brakes.subtitle")}
      </Text>
      <GroupedList>
        <GroupedRow
          icon="shield"
          label={t("brakes.costly")}
          sub={t("brakes.costlyHelp")}
          subLines={4}
          toggle={b.costly === "ask"}
          disabled={!editable}
          onPress={() => save({ costly: b.costly === "ask" ? "go" : "ask" })}
        />
        <GroupedRow
          label={t("brakes.atOnce")}
          sub={t("brakes.atOnceHelp")}
          subLines={3}
          value={String(b.maxUnrequested)}
          disabled={!editable}
          onPress={() => save({ maxUnrequested: nextOf(AT_ONCE, b.maxUnrequested) })}
        />
        <GroupedRow
          label={t("brakes.prs")}
          sub={t("brakes.prsHelp")}
          subLines={3}
          value={String(b.maxPrsPerHour)}
          disabled={!editable}
          onPress={() => save({ maxPrsPerHour: nextOf(PRS, b.maxPrsPerHour) })}
        />
        {b.go.length + b.never.length > 0 ? (
          <GroupedRow
            label={t("brakes.forget")}
            sub={[
              ...b.go.map((k) => t("brakes.rememberedGo", { what: t(`brakes.cost.${k}`) })),
              ...b.never.map((k) => t("brakes.rememberedNever", { what: t(`brakes.cost.${k}`) })),
            ].join(" · ")}
            subLines={3}
            disabled={!editable}
            onPress={() => save({ go: [], never: [] })}
          />
        ) : null}
      </GroupedList>
      <Text variant="footnote" tone="faint">
        {t("brakes.call")}
      </Text>
      <GroupedList>
        {(["all", "some", "none"] as const).map((v) => (
          <GroupedRow
            key={v}
            label={t(`brakes.call${v === "all" ? "All" : v === "some" ? "Some" : "None"}`)}
            checked={b.callAgents === v}
            disabled={!editable}
            onPress={() => save({ callAgents: v })}
          />
        ))}
        {b.callAgents === "some"
          ? others.map((a) => (
              <GroupedRow
                key={a.id}
                label={`@${a.handle}`}
                toggle={b.callAgentIds.includes(a.id)}
                disabled={!editable}
                onPress={() =>
                  save({
                    callAgentIds: b.callAgentIds.includes(a.id)
                      ? b.callAgentIds.filter((id) => id !== a.id)
                      : [...b.callAgentIds, a.id],
                  })
                }
              />
            ))
          : null}
      </GroupedList>
      <Text variant="footnote" tone="faint">
        {t("brakes.project")}
      </Text>
      <TextInput
        value={project}
        onChangeText={setProject}
        onEndEditing={() => project.trim() !== saved.project && save({ project: project.trim() })}
        editable={editable}
        maxLength={80}
        placeholder={t("brakes.projectPlaceholder")}
        placeholderTextColor={c.faint}
        accessibilityLabel={t("brakes.project")}
        style={[styles.input, fieldText("body"), { backgroundColor: c.raised, color: c.ink, borderColor: c.line }]}
      />
      <Text variant="footnote" tone="faint">
        {t("brakes.projectHelp")}
      </Text>
      {b.project ? (
        <GroupedList>
          <GroupedRow
            label={t("brakes.otherProjects")}
            toggle={b.otherProjects}
            disabled={!editable}
            onPress={() => save({ otherProjects: !b.otherProjects })}
          />
        </GroupedList>
      ) : null}
      <Text variant="footnote" tone="faint">
        {t("brakes.peopleNote")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 22, gap: 10 },
  input: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 12 },
});
