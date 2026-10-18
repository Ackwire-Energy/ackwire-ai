import { ImageFormat, Skia } from "@shopify/react-native-skia";
import { type ColorValue, type ImageSourcePropType, PixelRatio } from "react-native";
import { iconSvg } from "./iconSvg";
import type { IconName } from "./icons.data";

const cache = new Map<string, Promise<ImageSourcePropType | null>>();

function rasterize(name: IconName, size: number, color: string): ImageSourcePropType | null {
  const scale = PixelRatio.get();
  const px = Math.max(1, Math.round(size * scale));
  const svg = Skia.SVG.MakeFromString(iconSvg(name, color));
  const surface = Skia.Surface.Make(px, px);
  if (!svg || !surface) return null;
  surface.getCanvas().drawSvg(svg, px, px);
  surface.flush();
  const png = surface.makeImageSnapshot().encodeToBase64(ImageFormat.PNG, 100);
  return png ? { uri: `data:image/png;base64,${png}`, width: size, height: size, scale } : null;
}

/**
 * Our line icons as an icon "family" for the native tab bar on Android (`NativeTabs.Trigger.VectorIcon`):
 * drawn once with Skia into a PNG the tab bar tints. iOS uses SF Symbols instead. The promise is cached
 * per icon so re-renders (badge changes) don't load the image again.
 */
export const designIconFamily = {
  getImageSource(name: IconName, size: number, color: ColorValue): Promise<ImageSourcePropType | null> {
    const key = `${name}:${size}:${String(color)}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = Promise.resolve().then(() => {
        try {
          return rasterize(name, size, String(color));
        } catch {
          return null;
        }
      });
      cache.set(key, hit);
    }
    return hit;
  },
};
