/** What the desktop panel uses of noVNC 1.7.0's RFB client (the package's docs/API.md); the package ships no types. */
declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: { shared?: boolean });
    viewOnly: boolean;
    /** A dot in place of a pointer the desktop draws as nothing. */
    showDotCursor: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    /** 0–9. */
    qualityLevel: number;
    /** 0–9. */
    compressionLevel: number;
    focusOnClick: boolean;
    background: string;
    /** Sets the desktop's clipboard (only on a connection that may send input). */
    clipboardPasteFrom(text: string): void;
    /** One key: both press and release when `down` is omitted. `code`: a `KeyboardEvent.code`. */
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    focus(options?: FocusOptions): void;
    disconnect(): void;
  }
}
