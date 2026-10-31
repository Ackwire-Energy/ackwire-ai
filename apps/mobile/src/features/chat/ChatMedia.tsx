import type { GifMedia, MessageMedia, StickerMedia } from "@agenteschat/client";
import { gifLabel, gifMediaUrl, stickerLabel } from "@agenteschat/client/lib/media";
import { Canvas, createPicture, Picture } from "@shopify/react-native-skia";
import { Image } from "expo-image";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { replay } from "@/agent/skia-ctx";
import { stickerFrame } from "@/agent/sticker";
import { appHeaders, lastCookie } from "@/lib/auth";
import { serverUrl } from "@/lib/server";
import { CHROME_MAX_SCALE, Text } from "@/ui";
import { useReducedMotion } from "@/ui/theme";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { gifBox, MESSAGE_STICKER } from "./media";

/**
 * A message's GIF or sticker (ADR 0091). `align="end"`: my own message, on the right.
 */
export function ChatMedia({ media, align = "start" }: { media: MessageMedia; align?: "start" | "end" }) {
  return media.kind === "gif" ? <ChatGif media={media} align={align} /> : <ChatSticker media={media} align={align} />;
}

/**
 * A GIF: its file always from our server's media route (never the provider: the viewer's address stays with us),
 * with the session like every other picture of ours (cookie + `X-Agentes-Client`), at its own proportions up to
 * 260pt in the app's cut-corner frame, a small "GIF" mark on its corner; with reduced motion, its still frame. A file
 * that no longer loads (an admin turned GIFs off, the GIF gone) leaves a quiet card of its size with its title and
 * the mark, never a broken picture.
 */
function ChatGif({ media, align }: { media: GifMedia; align: "start" | "end" }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  const reduced = useReducedMotion();
  const [room, setRoom] = useState(0);
  const size = reduced ? "still" : "full";
  // Stable per file, so it isn't fetched again on every render.
  const source = useMemo(
    () => ({
      uri: gifMediaUrl(orgId, media.id, size, serverUrl()),
      headers: appHeaders(lastCookie()),
      cacheKey: `gif:${orgId}:${media.id}:${size}`,
    }),
    [orgId, media.id, size],
  );
  const [failed, setFailed] = useState<string | null>(null);
  const off = failed === source.uri;
  const box = gifBox(media.width, media.height, room);
  const title = media.title.trim();
  return (
    <View
      onLayout={(e) => setRoom(Math.floor(e.nativeEvent.layout.width))}
      style={[styles.wrap, align === "end" && styles.end]}
    >
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={gifLabel(t, media.title)}
        style={[styles.gif, { width: box.width, height: box.height, backgroundColor: c.sunken, borderColor: c.line }]}
      >
        {off ? (
          title ? (
            <View style={styles.offTitle}>
              <Text variant="footnote" tone="muted" numberOfLines={3} style={styles.center}>
                {title}
              </Text>
            </View>
          ) : null
        ) : (
          <Image
            source={source}
            recyclingKey={source.cacheKey}
            contentFit="cover"
            autoplay={!reduced}
            transition={120}
            style={StyleSheet.absoluteFill}
            onError={() => setFailed(source.uri)}
            accessible={false}
          />
        )}
        <View style={[styles.mark, off ? [styles.markOff, { borderColor: c.faint }] : styles.markOn]}>
          <Text
            variant="caption"
            maxFontSizeMultiplier={CHROME_MAX_SCALE}
            style={[styles.markText, { color: off ? c.faint : "#ffffff" }]}
          >
            {t("media.gifMark")}
          </Text>
        </View>
      </View>
    </View>
  );
}

/**
 * One of an agent's stickers: the agent itself in its mood, drawn from its look by the shared agent engine on Skia
 * (`stickerFrame`, as avatars are), at its still frame (ADR 0091: the phone shows them still), no frame and no
 * background. A former agent's sticker keeps its look; its name and mood are what screen readers say.
 */
function ChatSticker({ media, align }: { media: StickerMedia; align: "start" | "end" }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const agent = dir.anyAgent(media.agentId);
  const look = agentLook(agent);
  const { color, eyes, accessory } = look;
  const picture = useMemo(() => {
    const ops = stickerFrame({ color, eyes, accessory }, media.mood, MESSAGE_STICKER);
    return createPicture((canvas) => replay(canvas, ops), { width: MESSAGE_STICKER, height: MESSAGE_STICKER });
  }, [color, eyes, accessory, media.mood]);
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={stickerLabel(t, agent?.name ?? t("mobile.chat.someone"), media.mood)}
      style={[styles.sticker, align === "end" && styles.endSelf]}
    >
      <Canvas style={styles.stickerCanvas}>
        <Picture picture={picture} />
      </Canvas>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: "stretch", marginTop: 6 },
  end: { alignItems: "flex-end" },
  endSelf: { alignSelf: "flex-end" },
  // The app's cut corner ("tato com canto"): a hairline, small bottom-left corner.
  gif: {
    borderWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    borderBottomRightRadius: 14,
    borderBottomLeftRadius: 4,
    overflow: "hidden",
  },
  offTitle: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 32,
  },
  center: { textAlign: "center" },
  mark: { position: "absolute", left: 8, bottom: 8, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 5 },
  markOn: { backgroundColor: "rgba(0, 0, 0, 0.55)" },
  markOff: { borderWidth: 1.5 },
  markText: { fontSize: 10.5, lineHeight: 14, fontWeight: "700", letterSpacing: 0.5 },
  sticker: { width: MESSAGE_STICKER, height: MESSAGE_STICKER, marginTop: 4 },
  stickerCanvas: { width: MESSAGE_STICKER, height: MESSAGE_STICKER },
});
