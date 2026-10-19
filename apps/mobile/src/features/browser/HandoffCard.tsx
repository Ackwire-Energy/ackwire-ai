import { type BrowserHandoff, useBrowserHandoff } from "@agenteschat/client";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Icon, Text } from "@/ui";
import { useColors, useMeId, useOrgId } from "../shared/hooks";
import { useSurface } from "../shared/parts";
import { BrowserCard } from "./BrowserCard";
import { cardStateOf } from "./logic";
import { useOpenHandoffId } from "./open";

/**
 * An agent's request for help in its browser, in the conversation (NavegadorNoChat.html, A with the
 * "Céu" header): while it is open it is the agent's browser card, so Abrir takes the control right
 * here (no other screen); once it ends, one line with how. The state comes from the message
 * (`meta.browserHandoff`) and is refreshed from the server. A push or the inbox opens this card.
 */
export function HandoffCard({ handoff: fromMessage }: { handoff: BrowserHandoff }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const meId = useMeId();
  const c = useColors();
  const surface = useSurface();
  const openId = useOpenHandoffId();
  const fresh = useBrowserHandoff(orgId, fromMessage.id);
  const h: BrowserHandoff = fresh.data ?? fromMessage;
  const state = cardStateOf(h, meId);

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
  return <BrowserCard agentId={h.agentId} handoff={h} claim={openId === h.id} />;
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
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
