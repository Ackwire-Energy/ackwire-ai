import { ICONS, type IconName } from "./icons.data";

/**
 * A design-system icon as an SVG document (24×24 viewBox, stroke 1.7, round caps), the same geometry
 * `Icon` draws. Used to rasterize the Android tab bar icons (`tabIcons.ts`). Pure.
 */
export function iconSvg(name: IconName, color: string): string {
  const shapes = ICONS[name] ?? ICONS.circle;
  const body = shapes
    .map((s) => {
      if (s.t === "circle")
        return s.fill
          ? `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" fill="${color}"/>`
          : `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" fill="none" stroke="${color}" stroke-width="1.7"/>`;
      if (s.t === "rect")
        return `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${s.rx}" fill="none" stroke="${color}" stroke-width="1.7"/>`;
      return `<path d="${s.d}" fill="none" stroke="${color}" stroke-width="${s.sw ?? 1.7}" stroke-linecap="round" stroke-linejoin="round"/>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${body}</svg>`;
}
