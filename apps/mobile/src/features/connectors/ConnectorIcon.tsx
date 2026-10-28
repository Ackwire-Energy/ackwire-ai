import type { ConnectorDef } from "@agenteschat/client";
import { Image } from "expo-image";
import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { appHeaders, lastCookie } from "@/lib/auth";
import { serverUrl } from "@/lib/server";
import { Icon, type IconName, Text } from "@/ui";
import { useColors } from "../shared/hooks";
import { brandOf, iconUri, monogram, ownMarkUri, serverIconUri } from "./logic";

/**
 * A service's mark on a tile, as the web draws it: a one-color brand icon tinted in the brand's color (the ink for
 * near-black brands), else a mark in its own colors (the web's `/brands/` files, or the icon a server connected by
 * address gave as `image`, loaded with the session), else a monogram. `check`: a small check on the corner once it
 * is connected (no tags).
 */
export function ConnectorIcon({
  def,
  label,
  size = 44,
  check = false,
  image,
}: {
  def: Pick<ConnectorDef, "iconUrl" | "brandColor"> | null;
  label: string;
  size?: number;
  check?: boolean;
  image?: string | null;
}) {
  const c = useColors();
  const uri = def ? iconUri(serverUrl(), def.iconUrl) : null;
  const mark = def ? ownMarkUri(serverUrl(), def.iconUrl) : null;
  // Stable per URL, so the image isn't fetched again on every render. The web's own files are public: no session.
  const own = useMemo(() => {
    if (mark) return { uri: mark };
    const at = uri ? null : serverIconUri(serverUrl(), image);
    return at ? { uri: at, headers: appHeaders(lastCookie()) } : null;
  }, [uri, mark, image]);
  const tint = (def ? brandOf(def.brandColor) : null) ?? c.ink;
  const radius = Math.round(size * 0.3);
  return (
    <View
      style={[
        styles.tile,
        { width: size, height: size, borderRadius: radius, backgroundColor: c.raised, borderColor: c.line },
      ]}
      accessible={false}
    >
      {uri ? (
        <Image
          source={{ uri }}
          tintColor={tint}
          contentFit="contain"
          style={{ width: Math.round(size * 0.5), height: Math.round(size * 0.5) }}
        />
      ) : own ? (
        <Image
          source={own}
          contentFit="contain"
          style={{ width: Math.round(size * 0.58), height: Math.round(size * 0.58) }}
        />
      ) : (
        <Text variant="body" tone="muted" style={[styles.mono, { fontSize: Math.round(size * 0.36) }]}>
          {monogram(label)}
        </Text>
      )}
      {check ? (
        <View style={[styles.check, { backgroundColor: c.ok, borderColor: c.bg }]}>
          <Icon name="check" size={10} color="#ffffff" />
        </View>
      ) : null}
    </View>
  );
}

/** One of our own icons on the same tile (a built-in tool, a mailbox), where a service would show its mark. */
export function IconTile({ name, size = 20 }: { name: IconName; size?: number }) {
  const c = useColors();
  return (
    <View
      style={[
        styles.tile,
        {
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.3),
          backgroundColor: c.sunken,
          borderColor: c.line,
        },
      ]}
      accessible={false}
    >
      <Icon name={name} size={Math.round(size * 0.62)} color={c.muted} />
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth },
  mono: { fontWeight: "700" },
  check: {
    position: "absolute",
    right: -4,
    bottom: -4,
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
});
