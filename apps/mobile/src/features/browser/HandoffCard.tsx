import {
  type BrowserHandoff,
  handoffIsMine,
  handoffScreen,
  useBrowserHandoff,
  useBrowserHandoffActions,
} from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, Icon, Text, useToast } from "@/ui";
import { AskButtons, AskCard, AskFoot, ExpiryLine, useAskStore } from "../chat/asks";
import { IconTile } from "../connectors/ConnectorIcon";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { genderOf } from "../shared/logic";
import { PromptForm } from "../shared/PromptForm";
import { tapHaptic, useSurface } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { BrowserCard } from "./BrowserCard";
import { cardStateOf, NOTE_MAX } from "./logic";
import { useOpenHandoffId } from "./open";
import { FrameView, useLiveConnection } from "./parts";

/**
 * An agent's request for help in its browser, in the conversation. While nobody has opened it, it is the
 * request card: what the agent needs, "Ver a tela" showing its page as it is now, Abrir (takes the control
 * right here: the card becomes the agent's browser card) and "Agora não" (tells the agent, with an optional
 * reason). A request on the agent's desktop is the same card, Abrir taking it into the computer's full view (the
 * screen needs its room, ADR 0098), and one line that opens that view once someone helps there. Once someone is
 * in control of the browser it is the agent's browser card; once
 * it ends, one line with how. The state comes from the message (`meta.browserHandoff`) and is refreshed
 * from the server. A push or the inbox opens this card.
 */
export function HandoffCard({ handoff: fromMessage }: { handoff: BrowserHandoff }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const meId = useMeId();
  const c = useColors();
  const surface = useSurface();
  const openId = useOpenHandoffId();
  const dir = useDirectory();
  const fresh = useBrowserHandoff(orgId, fromMessage.id);
  const h: BrowserHandoff = fresh.data ?? fromMessage;
  const state = cardStateOf(h, meId);
  const desktop = handoffScreen(h) === "desktop";
  // Opened from here (Abrir, a push): the browser card that takes the request's place starts open.
  const [open, setOpen] = useState(false);

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
  if (desktop && (state === "mine" || state === "helping")) {
    const helper = h.controllerUserId ? dir.memberById.get(h.controllerUserId)?.name : undefined;
    return (
      <Pressable
        onPress={() => router.push(`/computer/${h.agentId}`)}
        accessibilityRole="button"
        style={[styles.done, surface]}
      >
        <Icon name="laptop" size={16} color={c.muted} />
        <Text variant="small" tone="muted" style={styles.grow}>
          {state === "mine"
            ? t("mobile.browser.live.inControl")
            : t("mobile.browser.live.helping", { name: helper ?? t("channel.unknownPerson") })}
        </Text>
      </Pressable>
    );
  }
  if (state === "waiting") {
    return <HandoffAsk handoff={h} desktop={desktop} claim={openId === h.id} onOpened={setOpen} />;
  }
  return <BrowserCard agentId={h.agentId} handoff={h} claim={openId === h.id} open={open} onToggle={setOpen} />;
}

/** The request while it waits: the request card. */
function HandoffAsk({
  handoff: h,
  desktop,
  claim,
  onOpened,
}: {
  handoff: BrowserHandoff;
  desktop: boolean;
  claim: boolean;
  onOpened: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const toast = useToast();
  const sheet = useSheet();
  const asks = useAskStore();
  const actions = useBrowserHandoffActions(orgId);
  const agent = dir.agentById.get(h.agentId);
  const name = agent?.name ?? "";
  const g = genderOf(name);
  // Whose it is goes by ids (the same rule as the line above the composer); a name only says who, once it loads.
  // Someone else's: who it waits for in the header when known, no buttons here.
  const mine = meId !== null && handoffIsMine(h, meId, agent?.ownerUserId, can(org, "control_computers"));
  const asked = h.requestedForUserId ? dir.memberById.get(h.requestedForUserId)?.name : undefined;
  const failed = () => toast({ title: t("mobile.app.failed"), icon: "x" });

  const take = async () => {
    tapHaptic();
    onOpened(true);
    try {
      await actions.takeControl(h.id);
      asks?.settle(h.id);
      if (desktop) router.push(`/computer/${h.agentId}`);
    } catch {
      failed();
    }
  };
  // A push or the inbox opened this request: it takes the control once (first one wins), when it is the person's.
  const claimed = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per request, when it opened the conversation
  useEffect(() => {
    if (!claim || !mine || claimed.current || h.status !== "pending") return;
    claimed.current = true;
    onOpened(true);
    actions.takeControl(h.id).then(
      () => {
        if (desktop) router.push(`/computer/${h.agentId}`);
      },
      () => {},
    );
  }, [claim, desktop, mine, h.id, h.status]);

  // "Agora não": the agent hears it couldn't be done now, with the reason if one is given.
  const notNow = () => {
    tapHaptic();
    sheet.open(
      <PromptForm
        title={t("mobile.browser.failed.title")}
        intro={t(`mobile.browser.failed.intro${g}`, { name })}
        placeholder={t("mobile.browser.failed.placeholder")}
        submitLabel={t("mobile.browser.failed.send")}
        allowEmpty
        onSubmit={async (text) => {
          sheet.close();
          try {
            await actions.failed(h.id, text.trim().slice(0, NOTE_MAX) || undefined);
            asks?.settle(h.id);
          } catch {
            failed();
          }
        }}
      />,
    );
  };

  return (
    <AskCard
      id={h.id}
      kind={desktop ? "desktop" : "browser"}
      agentId={h.agentId}
      waitsFor={mine ? "you" : asked ? t("ask.waitingFor", { name: asked }) : null}
      lead={h.instructions}
      well={{
        tile: <IconTile name={desktop ? "laptop" : "globe"} size={32} />,
        title: name,
        detail: null,
        more: desktop ? null : { label: t("ask.seeScreen"), content: <ScreenPeek agentId={h.agentId} /> },
      }}
      foot={
        <AskFoot expiry={h.expiresAt ? <ExpiryLine createdAt={h.createdAt} expiresAt={h.expiresAt} /> : null}>
          {mine ? (
            <AskButtons
              primary={
                <Button variant="primary" size="card" wide label={t("mobile.browser.card.open")} onPress={take} />
              }
              secondary={<Button variant="secondary" size="card" wide label={t("approval.notNow")} onPress={notNow} />}
            />
          ) : null}
        </AskFoot>
      }
    />
  );
}

/** The agent's page as it is now, to look at before taking it (watching only: taps do nothing). */
function ScreenPeek({ agentId }: { agentId: string }) {
  const c = useColors();
  const live = useLiveConnection(agentId, true);
  return (
    <View style={[styles.peek, { backgroundColor: c.sunken }]}>
      {live.frame ? (
        <FrameView frame={live.frame} enabled={false} onInput={live.sendInput} />
      ) : (
        <View style={styles.center}>
          <ActivityIndicator color={c.muted} />
        </View>
      )}
    </View>
  );
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
  peek: { aspectRatio: 16 / 10, borderRadius: 12, overflow: "hidden" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
