import type { InlinePart } from "@agenteschat/adapters";
import { dark, light, type ThemeColors } from "@agenteschat/tokens";
import { AGENT_GRADIENTS } from "@agenteschat/ui/agent/engine";
import { initialsOf } from "@agenteschat/ui/names";
import { mix, opaque } from "@agenteschat/ui/sky/math";

/** The languages emails are written in. */
export type EmailLocale = "pt-BR" | "en";

/**
 * Plain text; `{ b }` is bold. `{ mail }` is an address as a mailto link: already a link, no client links it on its
 * own, so it needs none of the hair spaces that break copying typed text (`inertText`). The layout escapes every
 * string, so the words never hold HTML.
 */
export type Inline = string | { b: string } | { mail: string };
export type Text = Inline | Inline[];
export type Block =
  | { p: Text }
  | { small: Text }
  /** A section title inside the card: a heading, so screen readers can jump to it. */
  | { h2: string }
  | { steps: [title: string, text: string][] }
  | { facts: [label: string, value: Text][] }
  | { note: Text; tone?: "warn" }
  /** A name with a line under it. `agent`: the agent's color (its face); none: a person's initials tile. */
  | { people: { name: string; detail: Text; agent?: string }[] }
  /** The primary button, and an optional second action as a link beside it. */
  | { button: string; url: string; also?: { label: string; url: string; danger?: boolean } }
  /** For emails whose link is the point: the address to copy when the button doesn't work. */
  | { fallback: string; url: string }
  /** A one-time code to type: large in a well, selectable as one word. */
  | { code: string };

export interface EmailDoc {
  lang: EmailLocale;
  subject: string;
  /** The line an inbox shows after the subject: our words only. */
  preheader: string;
  headline: string;
  blocks: Block[];
  /** Why this address got it, how often, who sent it. */
  footer: string[];
}

/**
 * Where an email's pictures come from: this server's `/email/` (`base`), or attached to each message
 * (`base` null, `files` read from the web app's `email/` folder), for a server people outside can't reach.
 */
export interface EmailArt {
  /** The server's own address: the logo links there. */
  home: string;
  /** `{PUBLIC_URL}/email/`, or null when the pictures are attached. */
  base: string | null;
  /** The pictures to attach, by file name (attached mode). */
  files: Map<string, Uint8Array> | null;
}

const AGENT_FACES = Object.keys(AGENT_GRADIENTS);
/** Every picture an email may show, as the web app serves them (`apps/web/public/email/`). */
export const EMAIL_PICTURES = [
  "logo-ink.png",
  "logo-bone.png",
  "sky-band.png",
  ...AGENT_FACES.map((c) => `agent-${c}.png`),
];
const FONT = "source-sans-3-latin.woff2";
const LOGO = { width: 173, height: 36, alt: "agentes.chat" } as const;
const SKY = { width: 552, height: 27 } as const;

/** Classic Outlook has no rgba: hairlines are the solid color they show over their surface. */
const palette = (t: ThemeColors) => ({
  page: t.bg,
  card: t.raised,
  border: opaque(t.line2, t.raised),
  well: t.sunken,
  wellHair: opaque(t.line, t.sunken),
  ink: t.ink,
  text: t.ink2,
  muted: t.muted,
  faint: t.faint,
  action: t.action,
  /** The top of the primary button's gradient, as the app's `color-mix(in srgb, var(--ink) 82%, var(--bg))`. */
  actionTop: mix(t.action, t.bg, 0.18),
  onAction: t.onAction,
  warnSoft: t.warnSoft,
  warn: t.warn,
  danger: t.danger,
});
const L = palette(light);
const D = palette(dark);

const SANS = "'Source Sans 3',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * The dark design, by class. The media query reaches Apple Mail, the Outlook apps, Samsung and Thunderbird;
 * the same rules under `[data-ogsc]`/`[data-ogsb]` reach Outlook.com and new Outlook, which stamp what
 * they recolour. No rule uses #ffffff: Apple Mail ignores it in dark rules.
 */
const DARK = [
  `.bg{background:${D.page}!important}`,
  `.card{background:${D.card}!important;border-color:${D.border}!important}`,
  `.ink{color:${D.ink}!important}`,
  `.tx{color:${D.text}!important}`,
  `.mu{color:${D.muted}!important}`,
  `.fa{color:${D.faint}!important}`,
  `.well{background:${D.well}!important}`,
  `.wh{border-color:${D.wellHair}!important}`,
  `.num{background:${D.card}!important;border-color:${D.border}!important;color:${D.muted}!important}`,
  `.btn{background:${D.action}!important;color:${D.onAction}!important}`,
  `.btn span{color:${D.onAction}!important}`,
  `.ln{color:${D.ink}!important;text-decoration-color:${D.border}!important}`,
  `.avp{background:${D.well}!important;color:${D.text}!important;border-color:${D.border}!important}`,
  `.warn{background:${D.warnSoft}!important}`,
  `.warn-t{color:${D.warn}!important}`,
  `.ln-d{color:${D.danger}!important;text-decoration-color:${D.border}!important}`,
  `.ln-m{color:${D.muted}!important;text-decoration-color:${D.border}!important}`,
  ".logo-ink{display:none!important}",
  ".logo-bone{display:block!important}",
];

const PHONE = [
  ".px{padding-left:16px!important;padding-right:16px!important}",
  ".card{padding:24px 20px!important}",
  ".h1{font-size:22px!important;line-height:28px!important}",
  ".sky{width:100%!important;height:auto!important}",
];

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** The muted house link. */
const LINK_MUTED = `color:${L.muted};text-decoration:underline;text-decoration-color:${L.border};text-underline-offset:3px`;

const inlines = (t: Text): Inline[] => (Array.isArray(t) ? t : [t]);
const html = (t: Text, bold = `font-weight:600;color:${L.ink}`) =>
  inlines(t)
    .map((i) =>
      typeof i === "string"
        ? esc(i)
        : "b" in i
          ? `<b class="ink" style="${bold}">${esc(i.b)}</b>`
          : `<a class="ln-m" href="mailto:${esc(i.mail)}" style="${LINK_MUTED}">${esc(i.mail)}</a>`,
    )
    .join("");
const plain = (t: Text) =>
  inlines(t)
    .map((i) => (typeof i === "string" ? i : "b" in i ? i.b : i.mail))
    .join("");

const T = (style: string) =>
  `role="presentation" cellpadding="0" cellspacing="0" border="0"${style ? ` style="${style}"` : ""}`;
const P = `font-family:${SANS};mso-line-height-rule:exactly`;
/**
 * `P` where typed text goes: a word too long for the line breaks instead of widening the card, since a
 * table cell grows to its longest word. Not on the facts' labels: there it would let a long value squeeze
 * a label mid-word.
 */
const PW = `${P};word-break:break-word`;
/** `P` for a link button: classic Outlook clips a button whose line height is exact. */
const PB = `font-family:${SANS};mso-line-height-rule:at-least`;
/**
 * The app's primary button (`.ac-btn--primary` in `packages/ui/src/styles/components.css`): its highlight, bottom
 * edge and shadows. Every client that draws box-shadow reads rgba(). The app's dark highlight is .12, too close to
 * matter on a 1 px line, so one value serves both themes.
 */
const LIFT =
  "inset 0 1px 0 rgba(255,255,255,.18),inset 0 -1px 0 rgba(0,0,0,.3),0 1px 2px rgba(0,0,0,.18),0 6px 14px -6px rgba(0,0,0,.45)";

const cidOf = (file: string) => `${file.replace(/\.png$/, "")}@agentes.chat`;

/** The pictures one email shows: linked, or attached (only those its HTML names). */
function pictures(art: EmailArt) {
  const used = new Set<string>();
  const src = (file: string) => {
    used.add(file);
    return art.base ? `${art.base}${file}` : `cid:${cidOf(file)}`;
  };
  const inline = (): InlinePart[] =>
    EMAIL_PICTURES.flatMap((file) => {
      const content = art.base || !used.has(file) ? undefined : art.files?.get(file);
      return content ? [{ cid: cidOf(file), filename: file, contentType: "image/png", content }] : [];
    });
  return { src, inline };
}

function block(b: Block, src: (file: string) => string): string {
  if ("p" in b)
    return `<p class="tx" style="margin:0 0 16px;${PW};font-size:16px;line-height:24px;color:${L.text}">${html(b.p)}</p>`;
  if ("small" in b)
    return `<p class="mu" style="margin:0 0 12px;${P};font-size:14px;line-height:20px;color:${L.muted}">${html(b.small)}</p>`;
  if ("h2" in b)
    return `<h2 class="ink" style="margin:24px 0 12px;${P};font-size:16px;line-height:22px;font-weight:600;color:${L.ink}">${esc(b.h2)}</h2>`;
  if ("steps" in b)
    return `<table width="100%" ${T("margin:0 0 4px")}>${b.steps
      .map(
        ([title, text], i) => `<tr>
<td width="36" valign="top" style="width:36px;padding:0 0 14px"><table ${T("")}><tr><td class="num" width="22" height="22" align="center" valign="middle" style="width:22px;height:22px;border:1px solid ${L.border};border-radius:7px;background:${L.card};${P};font-size:13px;line-height:22px;font-weight:600;color:${L.muted}">${i + 1}</td></tr></table></td>
<td valign="top" class="tx" style="padding:0 0 14px;${P};font-size:16px;line-height:24px;color:${L.text}"><b class="ink" style="font-weight:600;color:${L.ink}">${esc(title)}</b> ${esc(text)}</td>
</tr>`,
      )
      .join("")}</table>`;
  if ("facts" in b)
    return `<table width="100%" class="well" ${T(`background:${L.well};border-radius:12px;margin:0 0 20px`)}><tr><td style="padding:4px 16px">
<table width="100%" ${T("")}>${b.facts
      .map(
        ([label, value], i) => `<tr>
<td class="mu${i ? " wh" : ""}" valign="top" style="padding:10px 12px 10px 0;${i ? `border-top:1px solid ${L.wellHair};` : ""}${P};font-size:14px;line-height:20px;color:${L.muted}">${esc(label)}</td>
<td class="ink${i ? " wh" : ""}" valign="top" align="right" style="padding:10px 0;${i ? `border-top:1px solid ${L.wellHair};` : ""}${PW};font-size:14px;line-height:20px;font-weight:600;color:${L.ink};text-align:right">${html(value)}</td>
</tr>`,
      )
      .join("")}</table></td></tr></table>`;
  if ("note" in b) {
    const warn = b.tone === "warn";
    return `<table width="100%" class="${warn ? "warn" : "well"}" ${T(`background:${warn ? L.warnSoft : L.well};border-radius:12px;margin:0 0 16px`)}><tr>
<td class="${warn ? "warn-t" : "tx"}" style="padding:14px 16px;${PW};font-size:15px;line-height:22px;color:${warn ? L.warn : L.text}">${html(b.note, warn ? "font-weight:700" : `font-weight:600;color:${L.ink}`)}</td></tr></table>`;
  }
  if ("people" in b)
    // The face starts 5 px down, where the name's capitals start on its 15/20 px line (4.5 to 5.7 px across Source
    // Sans 3 and the system fonts): beside a name with a line under it, as the app's `.ac-captop`. Padding, not a
    // negative margin, which classic Outlook ignores.
    return `<table width="100%" ${T("margin:0 0 8px")}>${b.people
      .map(
        (p) => `<tr>
<td width="44" valign="top" style="width:44px;padding:5px 0 12px">${
          p.agent
            ? `<img src="${esc(src(`agent-${AGENT_FACES.includes(p.agent) ? p.agent : "sky"}.png`))}" width="32" height="32" alt="" style="display:block;border:0;outline:none;width:32px;height:32px">`
            : `<table ${T("")}><tr><td class="avp" width="30" height="30" align="center" valign="middle" style="width:30px;height:30px;border:1px solid ${L.border};border-radius:10px;background:${L.well};color:${L.text};${P};font-size:13px;line-height:30px;font-weight:700">${esc(initialsOf(p.name))}</td></tr></table>`
        }</td>
<td valign="top" style="padding:0 0 12px">
<p class="ink" style="margin:0;${PW};font-size:15px;line-height:20px;font-weight:600;color:${L.ink}">${esc(p.name)}</p><p class="mu" style="margin:0;${PW};font-size:14px;line-height:20px;color:${L.muted}">${html(p.detail)}</p></td>
</tr>`,
      )
      .join("")}</table>`;
  if ("code" in b)
    // Letter spacing trails the last digit too: 8 px more on the left keeps the digits centred.
    return `<table width="100%" class="well" ${T(`background:${L.well};border-radius:12px;margin:0 0 20px`)}><tr>
<td class="ink" align="center" style="padding:16px 16px 16px 24px;${P};font-size:32px;line-height:40px;font-weight:700;letter-spacing:8px;font-variant-numeric:tabular-nums;color:${L.ink};text-align:center">${esc(b.code)}</td></tr></table>`;
  if ("button" in b) {
    // A link button, clickable everywhere; classic Outlook gets its own spacers, in em at the 15 px label, and draws
    // it square and flat. The colour comes before the shorthand: a client without gradients keeps the colour, and
    // Gmail for Android breaks a gradient in an inline background-image.
    const btn = `<a class="btn" href="${esc(b.url)}" target="_blank" style="display:inline-block;background-color:${L.action};background:${L.action} linear-gradient(180deg,${L.actionTop} 0%,${L.action} 100%);border-radius:14px;box-shadow:${LIFT};color:${L.onAction};${PB};font-size:15px;line-height:20px;font-weight:600;text-decoration:none;padding:14px 16px;mso-padding-alt:0;text-underline-color:${L.action}"><!--[if mso]><i style="mso-font-width:107%;mso-text-raise:187%" hidden>&emsp;</i><![endif]--><span style="mso-text-raise:93%;color:${L.onAction}">${esc(b.button)}</span><!--[if mso]><i style="mso-font-width:107%" hidden>&emsp;&#8203;</i><![endif]--></a>`;
    // Four spaces too: classic Outlook ignores the span's width. The second label has no colour of its own, so the
    // dark rules reach it through the link, and classic Outlook raises it like the button's.
    const also = b.also
      ? `<span style="display:inline-block;width:16px;font-size:15px;line-height:20px">&nbsp;&nbsp;&nbsp;&nbsp;</span><a class="${b.also.danger ? "ln-d" : "ln"}" href="${esc(b.also.url)}" target="_blank" style="display:inline-block;padding:14px 0;color:${b.also.danger ? L.danger : L.ink};${PB};font-size:15px;line-height:20px;font-weight:600;text-decoration:underline;text-decoration-color:${L.border};text-underline-offset:3px;text-underline-color:${L.border}"><span style="mso-text-raise:93%">${esc(b.also.label)}</span></a>`
      : "";
    return `<table ${T("margin:8px 0 20px")}><tr><td>${btn}${also}</td></tr></table>`;
  }
  return `<p class="mu" style="margin:0 0 12px;${P};font-size:13px;line-height:19px;color:${L.muted}">${esc(b.fallback)}<br><a class="ln-m" href="${esc(b.url)}" target="_blank" style="${LINK_MUTED};word-break:break-all">${esc(b.url)}</a></p>`;
}

/** The plain-text part of a block: the same words, a button as `Label: url`. */
function text(b: Block): string {
  if ("p" in b) return plain(b.p);
  if ("small" in b) return plain(b.small);
  if ("h2" in b) return b.h2;
  if ("steps" in b) return b.steps.map(([title, x], i) => `${i + 1}. ${title} ${x}`).join("\n");
  if ("facts" in b) return b.facts.map(([label, v]) => `${label}: ${plain(v)}`).join("\n");
  if ("note" in b) return plain(b.note);
  // "Theo, Merge pull request #42" would read as an order to Theo.
  if ("people" in b) return b.people.map((p) => `${p.name} · ${plain(p.detail)}`).join("\n");
  if ("code" in b) return b.code;
  if ("button" in b) return [`${b.button}: ${b.url}`, ...(b.also ? [`${b.also.label}: ${b.also.url}`] : [])].join("\n");
  // The address is already in the button's line.
  return "";
}

/** After the preheader, so the body's first words don't trail into the inbox preview (iOS and Yahoo need the last two). */
const FILLER = "&#847;&zwnj;&nbsp;&#8199;&shy;".repeat(60);

/**
 * One email in our look: the light design inline, our dark design for the clients that apply an email's
 * own, the Gmail apps kept light, and a plain-text part with the same words.
 */
export function renderDoc(doc: EmailDoc, art: EmailArt): { html: string; text: string; inline: InlinePart[] } {
  const { src, inline } = pictures(art);
  const lang = doc.lang;
  const body = doc.blocks.map((b) => block(b, src)).join("\n");
  const logo = (file: string, cls: string, display: string, color: string) =>
    `<img class="${cls}" src="${esc(src(file))}" width="${LOGO.width}" height="${LOGO.height}" alt="${LOGO.alt}" style="display:${display};border:0;outline:none;width:${LOGO.width}px;height:${LOGO.height}px;font-family:${SANS};font-size:20px;font-weight:600;line-height:${LOGO.height}px;color:${color}">`;
  // `light only` keeps the Gmail apps from converting it; `:root{color-scheme:light dark}` keeps Apple Mail
  // applying our dark design. Risky rules sit in blocks of their own, so a client that drops one keeps the rest.
  // The dark button's gradient comes after the flat fill it paints over (the same specificity, so the later wins):
  // a client that rejects it keeps the flat fill.
  const html = `<!doctype html>
<html lang="${lang}" dir="ltr" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(doc.subject)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><style>body,table,td,p,a,span,b,h1,h2{font-family:'Segoe UI',Arial,sans-serif!important}</style><![endif]-->
<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
body{margin:0!important;padding:0!important;width:100%!important}
a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important}
@media (max-width:620px){${PHONE.join("")}}
</style>
<style>
@media (prefers-color-scheme:dark){${DARK.join("")}}
</style>
<style>
${DARK.map((r) => `[data-ogsc] ${r}[data-ogsb] ${r}`).join("\n")}
</style>
<style>
@media (prefers-color-scheme:dark){.btn{background-image:linear-gradient(180deg,${D.actionTop} 0%,${D.action} 100%)!important}}
</style>
${art.base ? `<!--[if !mso]><!--><style>@font-face{font-family:'Source Sans 3';font-style:normal;font-weight:200 900;size-adjust:107%;src:url('${esc(`${art.base}${FONT}`)}') format('woff2')}</style><!--<![endif]-->` : ""}
</head>
<body class="body bg" style="margin:0;padding:0;width:100%;background:${L.page};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;mso-hide:all">${esc(doc.preheader)}${FILLER}</div>
<div role="article" aria-roledescription="email" aria-label="${esc(doc.subject)}" lang="${lang}" dir="ltr">
<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${L.page}">
<tr><td align="center" class="px" style="padding:0 24px">
<!--[if mso]><table role="presentation" width="552" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:552px;margin:0 auto">
<tr><td style="padding:32px 0 20px">
<a href="${esc(art.home)}" target="_blank" style="display:inline-block;text-decoration:none">
${logo("logo-ink.png", "logo-ink", "block", L.ink)}
<!--[if !mso]><!-->${logo("logo-bone.png", "logo-bone", "none", D.ink)}<!--<![endif]-->
</a>
</td></tr>
<tr><td class="card" style="background:${L.card};border:1px solid ${L.border};border-radius:16px;padding:32px">
<h1 class="h1 ink" style="margin:0 0 16px;${P};font-size:24px;line-height:30px;font-weight:600;letter-spacing:-0.01em;color:${L.ink}">${esc(doc.headline)}</h1>
${body}
</td></tr>
<tr><td style="padding:24px 0 0"><img class="sky" src="${esc(src("sky-band.png"))}" width="${SKY.width}" height="${SKY.height}" alt="" style="display:block;border:0;outline:none;width:${SKY.width}px;max-width:100%;height:auto"></td></tr>
<tr><td style="padding:16px 0 40px">
${doc.footer.map((f) => `<p class="fa" style="margin:0 0 6px;${PW};font-size:13px;line-height:19px;color:${L.faint}">${esc(f)}</p>`).join("\n")}
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</div>
</body>
</html>`;
  const parts = [doc.headline, ...doc.blocks.map(text).filter(Boolean), doc.footer.join("\n")];
  return { html, text: `${parts.join("\n\n")}\n`, inline: inline() };
}
