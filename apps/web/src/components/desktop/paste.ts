/**
 * Xvnc's MaxCutText (its default): a larger clipboard from a viewer is dropped without a word. It counts what noVNC
 * sends: UTF-8 with every line break as CRLF, and a NUL at the end.
 */
export const PASTE_MAX_BYTES = 262_144;
/** Shift+Insert pastes and Ctrl+Insert copies in every window there, a terminal too. Inline: noVNC exports only RFB. */
export const SHIFT = { keysym: 0xffe1, code: "ShiftLeft" };
export const CONTROL = { keysym: 0xffe3, code: "ControlLeft" };
export const INSERT = { keysym: 0xff63, code: "Insert" };

/** What a text takes on the desktop's clipboard, in the bytes `PASTE_MAX_BYTES` counts. */
export const pasteBytes = (text: string) => new TextEncoder().encode(text.replace(/\r\n|\r|\n/g, "\r\n")).byteLength + 1;
