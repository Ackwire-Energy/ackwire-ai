import { type Actor, type Issue, type IssuePriority, useIssueAction } from "@agenteschat/client";
import { PRIORITIES } from "@agenteschat/client/lib/issues";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import {
  Filters,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  IconButton,
  SheetScreen,
  systemText,
  Text,
  useToast,
  weights,
} from "@/ui";
import { Face } from "../shared/Face";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { successHaptic } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { DUE_CHOICES, type DueChoice, dueDateOf } from "./logic";

type Open = "who" | "priority" | "due" | null;

const close = () => (router.canGoBack() ? router.back() : router.replace("/issues"));

/**
 * "Nova issue" (MobileDriveIssues.html), a native form sheet over Issues: the title, a description, who does
 * it (an agent picked here is asked right away, as on the web: it starts and the status moves on its own),
 * the priority and the due date. "Criar" in the header.
 */
export function NewIssueForm() {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const dir = useDirectory();
  const meId = useMeId();
  const action = useIssueAction(useOrgId());
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [who, setWho] = useState<Actor | null>(null);
  const [priority, setPriority] = useState<IssuePriority>("normal");
  const [due, setDue] = useState<DueChoice>("none");
  const [open, setOpen] = useState<Open>(null);
  const ready = title.trim().length > 0 && !action.isPending;
  const toggle = (o: Exclude<Open, null>) => setOpen((v) => (v === o ? null : o));
  const agents = dir.agents.filter((a) => a.canTalk !== false);
  const whoName = (a: Actor | null) =>
    !a ? t("mobile.issues.nobody") : a.type === "person" && a.id === meId ? t("mobile.issues.you") : dir.nameOf(a);
  const whoRole = who?.type === "agent" ? (dir.agentById.get(who.id)?.role ?? "") : "";

  const submit = () => {
    if (!ready) return;
    action.mutate(
      {
        type: "create",
        input: {
          title: title.trim(),
          description: text.trim(),
          assignee: who?.type === "person" ? who : null,
          priority,
          dueDate: dueDateOf(due),
        },
      },
      {
        onSuccess: (created) => {
          const issue = created as Issue;
          // An agent picked here starts right away: assigned, its run linked, in progress (as on the web).
          if (who?.type === "agent")
            action.mutate(
              { type: "ask", id: issue.id, agentId: who.id },
              // Couldn't ask (not in a shared channel…): it stays assigned to the agent.
              { onError: () => action.mutate({ type: "update", id: issue.id, patch: { assignee: who } }) },
            );
          successHaptic();
          toast({
            title: t("mobile.issues.form.created", { number: issue.number }),
            ...(who?.type === "agent" ? { agentId: who.id } : {}),
          });
          close();
        },
        onError: () => toast({ title: t("mobile.issues.form.createFailed"), icon: "x" }),
      },
    );
  };

  const choices: (Actor | null)[] = [
    ...agents.map((a) => ({ type: "agent" as const, id: a.id })),
    ...(meId ? [{ type: "person" as const, id: meId }] : []),
    null,
  ];
  return (
    <SheetScreen>
      <View style={styles.head}>
        <IconButton icon="x" label={t("mobile.common.close")} plate onPress={close} />
        <Text variant="title" style={styles.title} accessibilityRole="header" numberOfLines={1}>
          {t("mobile.issues.form.title")}
        </Text>
        <Pressable
          onPress={submit}
          disabled={!ready}
          accessibilityRole="button"
          accessibilityState={{ disabled: !ready }}
          hitSlop={8}
          style={[styles.create, { backgroundColor: ready ? c.ink : c.sunken }]}
        >
          <Text style={[styles.createText, { color: ready ? c.bg : c.faint }]}>{t("mobile.issues.form.create")}</Text>
        </Pressable>
      </View>
      <TextArea
        value={title}
        onChangeText={setTitle}
        placeholder={t("mobile.issues.form.titlePlaceholder")}
        accessibilityLabel={t("issues.form.title")}
        multiline={false}
        minHeight={50}
        autoFocus
        returnKeyType="next"
        maxLength={300}
      />
      <TextArea
        value={text}
        onChangeText={setText}
        placeholder={t("mobile.issues.form.description")}
        accessibilityLabel={t("mobile.issues.form.description")}
        minHeight={96}
        maxLength={50_000}
      />
      <View>
        <GroupedHeader>{t("mobile.issues.form.who")}</GroupedHeader>
        <GroupedList>
          <GroupedRow
            label={whoName(who)}
            leading={who ? <Face who={who} size={26} live={false} /> : undefined}
            icon={who ? undefined : "agent"}
            value={whoRole || undefined}
            chevron
            onPress={() => toggle("who")}
          />
          {open === "who"
            ? choices
                .filter((a) => (a?.type ?? null) !== (who?.type ?? null) || a?.id !== who?.id)
                .map((a) => (
                  <GroupedRow
                    key={a ? `${a.type}:${a.id}` : "nobody"}
                    label={whoName(a)}
                    leading={a ? <Face who={a} size={26} live={false} /> : undefined}
                    icon={a ? undefined : "circle"}
                    value={a?.type === "agent" ? (dir.agentById.get(a.id)?.role ?? undefined) : undefined}
                    onPress={() => {
                      setWho(a);
                      setOpen(null);
                    }}
                  />
                ))
            : null}
        </GroupedList>
        {who?.type === "agent" ? <GroupedFooter>{t("mobile.issues.form.agentStarts")}</GroupedFooter> : null}
      </View>
      <View>
        <GroupedHeader>{t("mobile.issues.form.details")}</GroupedHeader>
        <GroupedList>
          <GroupedRow
            icon="flag"
            label={t("issues.form.priority")}
            value={t(`issues.priority.${priority}`)}
            chevron
            onPress={() => toggle("priority")}
          />
          {open === "priority" ? (
            <View style={styles.inline}>
              <Filters
                items={PRIORITIES.map((p) => ({ key: p, label: t(`issues.priority.${p}`) }))}
                value={priority}
                onChange={(k) => {
                  setPriority(k as IssuePriority);
                  setOpen(null);
                }}
              />
            </View>
          ) : null}
          <GroupedRow
            icon="clock"
            label={t("mobile.issues.form.due")}
            value={t(`mobile.issues.form.dueChoice.${due}`)}
            chevron
            onPress={() => toggle("due")}
          />
          {open === "due" ? (
            <View style={styles.inline}>
              <Filters
                items={DUE_CHOICES.map((d) => ({ key: d, label: t(`mobile.issues.form.dueChoice.${d}`) }))}
                value={due}
                onChange={(k) => {
                  setDue(k as DueChoice);
                  setOpen(null);
                }}
              />
            </View>
          ) : null}
        </GroupedList>
      </View>
    </SheetScreen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 50, marginBottom: 4 },
  title: { flex: 1, textAlign: "center" },
  create: {
    minWidth: 64,
    height: 36,
    borderRadius: 18,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  createText: { ...systemText("subhead", weights.semibold) },
  inline: { paddingVertical: 10, marginHorizontal: -2 },
});
