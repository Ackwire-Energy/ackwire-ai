import { useMemo } from "react";
import { Image } from "react-native";
import { appHeaders, lastCookie } from "@/lib/auth";
import { photoSource } from "@/lib/photo";
import { serverUrl } from "@/lib/server";
import { LogoMark } from "@/ui";

/**
 * A workspace's face, as the web's `OrgMark`: its logo in the agent's shape (rounded, the bottom-left corner cut
 * closer), else the agent mark.
 */
export function OrgAvatar({ logo, size = 30 }: { logo?: string | null | undefined; size?: number }) {
  // Stable per logo, so the image isn't fetched again on every render.
  const source = useMemo(() => photoSource(logo, serverUrl(), appHeaders(lastCookie())), [logo]);
  if (!source) return <LogoMark size={size} />;
  const round = size * 0.3;
  return (
    <Image
      source={source}
      style={{
        width: size,
        height: size,
        borderTopLeftRadius: round,
        borderTopRightRadius: round,
        borderBottomRightRadius: round,
        borderBottomLeftRadius: size * 0.09,
      }}
      accessibilityIgnoresInvertColors
    />
  );
}
