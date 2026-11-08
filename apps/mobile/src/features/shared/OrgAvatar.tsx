import { useMemo } from "react";
import { Image, StyleSheet, View } from "react-native";
import { appHeaders, lastCookie } from "@/lib/auth";
import { photoSource } from "@/lib/photo";
import { serverUrl } from "@/lib/server";
import { WorkspaceSky } from "@/sky/Sky";
import { LogoMark, Text } from "@/ui";
import { useColors } from "./hooks";

/** From this size the mark draws the workspace's own sky behind its initial; smaller, the sky turned into a smudge. */
const SKY_FROM = 48;

/**
 * A workspace's face, as the web's `OrgMark`: its logo in the agent's shape (rounded, the bottom-left corner cut
 * closer). Without a logo and with its `name`, the workspace's initial: over the sky of its server (day on the Cloud,
 * dusk on a team's own) from 48 points, on a neutral plate below that, so every workspace in a list has a mark of its
 * own (ADR 0154). Without a name either, the agent mark.
 */
export function OrgAvatar({
  logo,
  name,
  size = 30,
  server,
}: {
  logo?: string | null | undefined;
  /** The workspace's name, for its initial when it has no logo. */
  name?: string | null;
  size?: number;
  /** The server the logo is on (another one signed in to, in Workspaces: ADR 0154); the current one by default. */
  server?: string;
}) {
  const c = useColors();
  // Stable per logo, so the image isn't fetched again on every render.
  const source = useMemo(() => {
    const on = server ?? serverUrl();
    return photoSource(logo, on, appHeaders(lastCookie(on)));
  }, [logo, server]);
  const round = size * 0.3;
  const shape = {
    width: size,
    height: size,
    borderTopLeftRadius: round,
    borderTopRightRadius: round,
    borderBottomRightRadius: round,
    borderBottomLeftRadius: size * 0.09,
  };
  if (source) return <Image source={source} style={shape} accessibilityIgnoresInvertColors />;
  const initial = initialOf(name);
  if (!initial) return <LogoMark size={size} />;
  const host = hostOf(server ?? serverUrl());
  return (
    <View style={[shape, styles.plate, { backgroundColor: c.sunken }]} accessibilityElementsHidden>
      {size >= SKY_FROM ? <WorkspaceSky host={host} fade={0.9} style={StyleSheet.absoluteFill} /> : null}
      <Text
        allowFontScaling={false}
        style={{ fontSize: Math.round(size * 0.42), lineHeight: Math.round(size * 0.5), fontWeight: "700", color: c.ink }}
      >
        {initial}
      </Text>
    </View>
  );
}

/** The first letter as the person reads it: one grapheme (an emoji stays whole), upper-cased; "" for no name. */
export function initialOf(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "";
  const first = Array.from(trimmed)[0] ?? "";
  return first.toLocaleUpperCase();
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

const styles = StyleSheet.create({
  plate: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
});
