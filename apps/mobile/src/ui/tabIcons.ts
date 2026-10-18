import { ImageFormat, Skia } from "@shopify/react-native-skia";
import { type ImageSourcePropType, PixelRatio, Platform } from "react-native";
import { parseTabGlyphKey, type TabGlyphKey, tabGlyphSvg } from "./tabGlyphs";

/**
 * Point size of a tab glyph: iOS tab bars show ~25pt glyphs (our 24-grid glyphs keep a margin, so they
 * draw a little bigger to sit like the system's); Material bottom navigation uses 24dp icons.
 */
const GLYPH_PT = Platform.OS === "ios" ? 28 : 24;

const cache = new Map<string, Promise<ImageSourcePropType | null>>();

/** An SVG drawn with Skia into a PNG data URI at the screen's scale (`size` in points). */
function rasterize(svgText: string, size: number): ImageSourcePropType | null {
  const scale = PixelRatio.get();
  const px = Math.max(1, Math.round(size * scale));
  const svg = Skia.SVG.MakeFromString(svgText);
  const surface = Skia.Surface.Make(px, px);
  if (!svg || !surface) return null;
  surface.getCanvas().drawSvg(svg, px, px);
  surface.flush();
  const png = surface.makeImageSnapshot().encodeToBase64(ImageFormat.PNG, 100);
  return png ? { uri: `data:image/png;base64,${png}`, width: size, height: size, scale } : null;
}

/**
 * Our tab glyphs as an icon "family" for the native tab bar on both platforms
 * (`NativeTabs.Trigger.VectorIcon family={tabGlyphFamily} name="agents.selected"`). Each glyph is drawn
 * once with Skia into a PNG (a data URI with its scale, which UIKit's and Android's image loaders both
 * read); the bar tints it (template rendering on iOS, the item tint on Android). The size and color the
 * tab bar asks for are ignored: the glyph has its own size and only its alpha counts. Promises are cached
 * per glyph so re-renders (badge changes) don't load the image again.
 */
export const tabGlyphFamily = {
  getImageSource(name: TabGlyphKey): Promise<ImageSourcePropType | null> {
    let hit = cache.get(name);
    if (!hit) {
      hit = Promise.resolve().then(() => {
        const parsed = parseTabGlyphKey(name);
        if (!parsed) return null;
        try {
          return rasterize(tabGlyphSvg(parsed.glyph, parsed.selected), GLYPH_PT);
        } catch {
          return null;
        }
      });
      cache.set(name, hit);
    }
    return hit;
  },
};
