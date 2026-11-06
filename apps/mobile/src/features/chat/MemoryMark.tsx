import { cacheMessageMemories, keys, type Message, type MessageMemory, useApi } from "@agenteschat/client";
import { formatTime } from "@agenteschat/client/lib/format";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { AgentReadingBook } from "@/agent/ReadingBook";
import { useOrg } from "@/providers/org";
import { Button, Card, Text, useToast } from "@/ui";
import { canEditMemories } from "../agents/logic";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useMeId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { SheetTitle } from "../shared/PromptForm";
import { useSheet } from "../shared/SheetHost";
import { TextArea } from "../shared/TextArea";

/** The marks one message shows (the web's too). */
const MARKS_MAX = 3;
/** A fact read aloud on its mark, cut. */
const short = (text: string, n = 90) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);

/**
 * What agents saved to memory from this person's message, at the end of its reactions (the web's `MemoryMarks`):
 * the agent reading an open pixel book, squarer and raised, after a small divider when reactions come first. Not
 * an emoji anyone can add. A tap opens what was saved (`MemorySheet`). The server sends only what whoever reads
 * the message may read.
 */
export function MemoryMarks({ message, divided }: { message: Message; divided: boolean }) {
  const { t } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const sheet = useSheet();
  const memories = message.memories ?? [];
  if (memories.length === 0) return null;
  return (
    <>
      {divided ? <View style={[styles.sep, { backgroundColor: c.line }]} /> : null}
      {memories.slice(0, MARKS_MAX).map((memory) => {
        const agent = dir.agentById.get(memory.agentId);
        const name = agent?.name ?? t("channel.unknownAgent");
        return (
          <Pressable
            key={memory.id}
            onPress={() => sheet.open(<MemorySheet message={message} memory={memory} onClose={sheet.close} />)}
            accessibilityRole="button"
            accessibilityLabel={t("memoryMark.label", { name, text: short(memory.text) })}
            // 44 tall to the finger; across, within the row's gap.
            hitSlop={{ top: 7, bottom: 7, left: 3, right: 3 }}
            style={({ pressed }) => [
              styles.mark,
              { backgroundColor: c.raised, borderColor: c.line },
              pressed && styles.pressed,
            ]}
          >
            <AgentReadingBook look={agentLook(agent)} />
          </Pressable>
        );
      })}
    </>
  );
}

/**
 * What one agent saved from a message, as the web's card: the fact, where it came from, Corrigir (in place) and
 * Esquecer (with Desfazer) for the agent's owner or who reviews memory, and Ver na memória.
 */
function MemorySheet({ message, memory, onClose }: { message: Message; memory: MessageMemory; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const dir = useDirectory();
  const meId = useMeId();
  const { orgId, org } = useOrg();
  const agent = dir.agentById.get(memory.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const canEdit = canEditMemories(agent, { id: meId, org });
  const [text, setText] = useState(memory.text);
  const [mode, setMode] = useState<"card" | "edit" | "forgot">("card");
  const [draft, setDraft] = useState(memory.text);
  // The marks as this client has them now: the cached list's message (it may have changed since the sheet opened).
  const marks = (): MessageMemory[] => {
    for (const [, data] of qc.getQueriesData({ queryKey: ["org", orgId, "channel", message.channelId] })) {
      if (!Array.isArray(data)) continue;
      const found = (data as Message[]).find((m) => m && m.id === message.id);
      if (found) return found.memories ?? [];
    }
    return message.memories ?? [];
  };
  const setMarks = (next: MessageMemory[]) => cacheMessageMemories(qc, orgId, message.channelId, message.id, next);
  const afterChange = () => void qc.invalidateQueries({ queryKey: keys.memory(orgId, memory.agentId) });
  const [id, setId] = useState(memory.id);
  const [before, setBefore] = useState<MessageMemory[] | null>(null);

  const fix = useMutation({
    mutationFn: (next: string) => api.memory.edit(orgId, id, next),
    onSuccess: (saved) => {
      // A fix is a new version: the mark now points at it.
      setMarks(marks().map((m) => (m.id === id ? { ...m, id: saved.id, text: saved.text } : m)));
      setId(saved.id);
      setText(saved.text);
      afterChange();
      setMode("card");
      toast({ title: t("memoryMark.fixed"), subtitle: t("memoryMark.fixedDetail", { name }) });
    },
    onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
  });
  const forget = useMutation({
    mutationFn: () => api.memory.setArchived(orgId, id, true),
    onSuccess: () => {
      const had = marks();
      setBefore(had);
      setMarks(had.filter((m) => m.id !== id));
      afterChange();
      setMode("forgot");
    },
    onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
  });
  const restore = useMutation({
    mutationFn: () => api.memory.setArchived(orgId, id, false),
    onSuccess: () => {
      if (before) setMarks(before);
      afterChange();
      setMode("card");
    },
    onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
  });
  const author = dir.nameOf(message.author);

  return (
    <>
      <SheetTitle
        leading={<AgentFace agentId={memory.agentId} size={36} live={false} />}
        title={t("memoryMark.title", { name })}
        subtitle={t("memoryMark.subtitle")}
      />
      {mode === "forgot" ? (
        <Card>
          <View style={styles.fact}>
            <Text variant="body" tone="muted">
              {t("memoryMark.forgot", { name })}
            </Text>
          </View>
        </Card>
      ) : mode === "edit" ? (
        <TextArea
          value={draft}
          onChangeText={setDraft}
          accessibilityLabel={t("memoryMark.fixLabel")}
          maxLength={2000}
          autoFocus
        />
      ) : (
        <Card>
          <View style={styles.fact}>
            <Text variant="body" selectable>
              {text}
            </Text>
            <Text variant="footnote" tone="muted">
              {t("memoryMark.from", { name: author, time: formatTime(i18n.language, message.createdAt) })}
            </Text>
          </View>
        </Card>
      )}
      {mode === "forgot" ? (
        <Button
          variant="secondary"
          wide
          icon="undo"
          label={t("memoryMark.undo")}
          loading={restore.isPending}
          onPress={() => restore.mutate()}
        />
      ) : mode === "edit" ? (
        <View style={styles.row}>
          <View style={styles.grow}>
            <Button variant="secondary" wide label={t("mobile.common.cancel")} onPress={() => setMode("card")} />
          </View>
          <View style={styles.grow}>
            <Button
              variant="primary"
              wide
              label={t("memoryMark.save")}
              loading={fix.isPending}
              onPress={() => {
                const next = draft.trim();
                if (next && next !== text) fix.mutate(next);
                else setMode("card");
              }}
            />
          </View>
        </View>
      ) : (
        <>
          {canEdit ? (
            <View style={styles.row}>
              <View style={styles.grow}>
                <Button
                  variant="secondary"
                  wide
                  icon="pen"
                  label={t("memoryMark.fix")}
                  onPress={() => {
                    setDraft(text);
                    setMode("edit");
                  }}
                />
              </View>
              <View style={styles.grow}>
                <Button
                  variant="secondary"
                  wide
                  icon="x"
                  label={t("memoryMark.forget")}
                  loading={forget.isPending}
                  onPress={() => forget.mutate()}
                />
              </View>
            </View>
          ) : null}
          <Button
            variant="ghost"
            wide
            label={t("memoryMark.view")}
            onPress={() => {
              onClose();
              router.push(`/agent/${memory.agentId}`);
            }}
          />
        </>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  // A small divider after the reactions, as the web's.
  sep: { width: StyleSheet.hairlineWidth, height: 16, alignSelf: "center", marginHorizontal: 2 },
  // Squarer than a reaction, raised and outlined: not an emoji anyone can add.
  mark: {
    height: 30,
    paddingLeft: 4,
    paddingRight: 5,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { opacity: 0.7 },
  fact: { gap: 6, paddingHorizontal: 14, paddingVertical: 12 },
  row: { flexDirection: "row", gap: 8 },
  grow: { flex: 1 },
});
