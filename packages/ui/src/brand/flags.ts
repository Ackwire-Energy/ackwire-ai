/** Small bundled country marks; absent countries use the caller's globe. No remote assets. */
const stripes = (colors: string[], vertical = false) =>
  colors
    .map(
      (color, i) =>
        `<path fill="${color}" d="${vertical ? `M${(i * 30) / colors.length} 0h${30 / colors.length}v20H${(i * 30) / colors.length}z` : `M0 ${(i * 20) / colors.length}h30v${20 / colors.length}H0z`}"/>`,
    )
    .join("");
const star = `<path d="M0-1l.3.7.7.02-.55.45.2.75L0 .5l-.65.42.2-.75L-1-.28l.7-.02z"/>`;
const usa =
  stripes(Array.from({ length: 13 }, (_, i) => (i % 2 ? "#fff" : "#b31942"))) +
  `<path fill="#0a3161" d="M0 0h12v10.77H0z"/><g fill="#fff">` +
  Array.from({ length: 9 }, (_, row) =>
    Array.from(
      { length: row % 2 ? 5 : 6 },
      (_, col) => `<g transform="translate(${1 + col * 2 + (row % 2)} ${1 + row * 1.1}) scale(.5)">${star}</g>`,
    ).join(""),
  ).join("") +
  `</g>`;
const FLAGS: Record<string, string> = {
  US: usa,
  DE: stripes(["#000", "#d00", "#ffce00"]),
  FR: stripes(["#002654", "#fff", "#ed2939"], true),
  NL: stripes(["#ae1c28", "#fff", "#21468b"]),
  IT: stripes(["#009246", "#fff", "#ce2b37"], true),
  IE: stripes(["#169b62", "#fff", "#ff883e"], true),
  BE: stripes(["#000", "#fdda24", "#ef3340"], true),
  PL: stripes(["#fff", "#dc143c"]),
  UA: stripes(["#0057b7", "#ffd700"]),
  JP: `<path fill="#fff" d="M0 0h30v20H0z"/><circle fill="#bc002d" cx="15" cy="10" r="6"/>`,
  BR: `<path fill="#009739" d="M0 0h30v20H0z"/><path fill="#fedf00" d="m15 2 13 8-13 8L2 10z"/><circle fill="#002776" cx="15" cy="10" r="5"/><path fill="none" stroke="#fff" stroke-width=".8" d="M10.1 9a12 12 0 0 1 9.2 3"/><g fill="#fff"><circle cx="14" cy="13" r=".3"/><circle cx="16" cy="11.5" r=".3"/><circle cx="13" cy="10" r=".2"/><circle cx="17" cy="13" r=".2"/></g>`,
};
export function countryFlagSvg(country: string | undefined): string | null {
  const mark = country ? FLAGS[country.toUpperCase()] : undefined;
  return mark ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 20">${mark}</svg>` : null;
}
export const countryFlagUrl = (country: string | undefined) => {
  const svg = countryFlagSvg(country);
  return svg ? `data:image/svg+xml,${encodeURIComponent(svg)}` : null;
};
