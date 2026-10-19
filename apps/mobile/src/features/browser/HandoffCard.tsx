import { useBrowserHandoff } from "@agenteschat/client";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Button, Fuse, Icon, Text } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useMeId, useNow, useOrgId } from "../shared/hooks";
import { agentLook, fuseRemaining, genderOf, minutesLeft } from "../shared/logic";
import { tapHaptic, useSurface } from "../shared/parts";
import { cardStateOf, type HandoffCard as Handoff } from "./logic";

/**
 * "Dev precisa de ajuda" in the conversation (NavegadorAgente.html, "Pedido no chat"): who asks, what to
 * do in the agent's browser, the fuse until nobody opening it ends the request, and Abrir. Once someone
 * is in control it says who; once it ends, one line with how. The card's state comes from the message
 * (`meta.browserHandoff`) and is refreshed from the server.
 */
export function HandoffCard({ handoff: fromMessage }: { handoff: Handoff }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const meId = useMeId();
  const dir = useDirectory();
  const c = useColors();
  const now = useNow(15_000);
  const surface = useSurface();
  const raised = useSurface("e2");
  const fresh = useBrowserHandoff(orgId, fromMessage.id);
  const h = { ...fromMessage, ...(fresh.data ?? {}) } as Handoff;
  const agent = dir.agentById.get(h.agentId);
  const name = agent?.name ?? "";
  const state = cardStateOf(h, meId);
  const open = () => {
    tapHaptic();
    router.push(`/handoff/${h.id}`);
  };

  if (state === "done" || state === "failed" || state === "expired" || state === "cancelled") {
    const ok = state === "done";
    return (
      <View style={[styles.done, surface]}>
        <Icon name={ok ? "checkc" : state === "failed" ? "x" : "clock"} size={16} color={ok ? c.ok : c.muted} />
        <Text variant="small" tone="muted" style={styles.grow}>
          {state === "failed" && h.note
            ? t("mobile.browser.card.failedNote", { note: h.note })
            : t(`mobile.browser.card.${state}`, { title: h.instructions })}
        </Text>
      </View>
    );
  }

  const helper = h.controllerUserId ? dir.nameOf({ type: "person", id: h.controllerUserId }) : "";
  const minutes = h.expiresAt ? minutesLeft(h.expiresAt, now) : null;
  return (
    <View style={[styles.card, raised]}>
      <View style={styles.label}>
        <AgentFace agentId={h.agentId} size={22} live={false} />
        <Text variant="footnote" tone="muted" numberOfLines={1} style={[styles.medium, styles.grow]}>
          {state === "waiting"
            ? t("mobile.browser.card.needs", { name })
            : state === "mine"
              ? t("mobile.browser.card.mine")
              : t("mobile.browser.card.helping", { name: helper || t("mobile.chat.someone") })}
        </Text>
        {state === "waiting" && minutes !== null ? (
          <View style={styles.left}>
            <Icon name="clock" size={13} color={c.amber} />
            <Text variant="footnote" style={[styles.medium, styles.tabular, { color: c.amber }]}>
              {t("mobile.browser.card.minutes", { count: minutes })}
            </Text>
          </View>
        ) : null}
      </View>
      <Text variant="title" style={styles.title}>
        {h.instructions}
      </Text>
      <View style={[styles.where, { backgroundColor: c.sunken }]}>
        <Icon name="globe" size={16} color={c.muted} />
        <Text variant="small" tone="muted" numberOfLines={1} style={styles.grow}>
          {t(`mobile.browser.card.where${genderOf(name)}`, { name })}
        </Text>
      </View>
      {state === "helping" ? (
        <Button variant="secondary" size="sm" wide icon="globe" label={t("mobile.browser.card.watch")} onPress={open} />
      ) : (
        <Button
          variant="primary"
          wide
          icon="out"
          label={state === "mine" ? t("mobile.browser.card.back") : t("mobile.browser.card.open")}
          onPress={open}
        />
      )}
      {state === "waiting" && h.expiresAt ? (
        <Fuse
          color={agentLook(agent).color}
          remaining={fuseRemaining(h.createdAt, h.expiresAt, now)}
          style={styles.fuse}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 12, padding: 14, borderRadius: 20, overflow: "hidden" },
  label: { flexDirection: "row", alignItems: "center", gap: 6 },
  left: { flexDirection: "row", alignItems: "center", gap: 4 },
  medium: { fontWeight: "500" },
  tabular: { fontVariant: ["tabular-nums"] },
  grow: { flex: 1, minWidth: 0 },
  title: { marginTop: 6, marginBottom: 10, fontSize: 18, lineHeight: 23, letterSpacing: -0.27 },
  where: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 14,
    marginBottom: 12,
  },
  fuse: { marginTop: 12, marginHorizontal: -14, marginBottom: -14 },
  done: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 20,
  },
});
