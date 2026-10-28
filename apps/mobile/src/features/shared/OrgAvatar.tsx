import { useMemo } from "react";
import { Image, StyleSheet, View } from "react-native";
import { appHeaders, lastCookie } from "@/lib/auth";
import { photoSource } from "@/lib/photo";
import { serverUrl } from "@/lib/server";
import { Text } from "@/ui";
import { useColors } from "./hooks";

/** A workspace's face: its logo, or its initial on a neutral tile, a rounded square as an app's icon. */
export function OrgAvatar({ name, logo, size = 30 }: { name: string; logo?: string | null | undefined; size?: number }) {
  const c = useColors();
  // Stable per logo, so the image isn't fetched again on every render.
  const source = useMemo(() => photoSource(logo, serverUrl(), appHeaders(lastCookie())), [logo]);
  const box = { width: size, height: size, borderRadius: Math.round(size * 0.27) };
  if (source) return <Image source={source} style={[styles.box, box]} accessibilityIgnoresInvertColors />;
  return (
    <View style={[styles.box, box, { backgroundColor: c.ink2 }]}>
      <Text variant="label" style={{ color: c.bg }}>
        {(name.trim()[0] ?? "?").toLocaleUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
});
