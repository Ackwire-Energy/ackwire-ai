import type { TerminalViewState } from "@agenteschat/client";
import { isTerminalExit, terminalCloseState, terminalSize, terminalSocketUrl } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Button, SkyStrip } from "@agenteschat/ui";
import { type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDirectory } from "@/hooks/useDirectory";
import { SocketFactoryContext } from "@/realtime/context";
import { Cover } from "../browser/BrowserCard";
import { useOrg } from "../org-context";
import { colorOf } from "../Sky";
import "@xterm/xterm/css/xterm.css";
import "../browser/browser.css";
import "./desktop.css";

/**
 * A terminal on the agent's computer (ADR 0058 §6): xterm.js on a socket of its own, sized to the panel. Keys go
 * out as bytes and the panel's size as `resize`; what the shell prints comes back as bytes. When the shell or the
 * connection ends it says so and waits for "Abrir de novo": a new socket is a new shell, so a person never types
 * into one they didn't see start. Whether this person may open it, and whether the computer serves one, the
 * server says with the socket's close code.
 */
export function TerminalView({ agentId, name, onClose }: { agentId: string; name: string; onClose?: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const createSocket = useContext(SocketFactoryContext);
  const g = agentGrammar(t, name);
  const color = colorOf(dir.agentById.get(agentId));
  const [view, setView] = useState<{ state: TerminalViewState; reason?: string }>({ state: "connecting" });
  const [round, setRound] = useState(0);
  const host = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new `round` is a new shell
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    setView({ state: "connecting" });
    let cancelled = false;
    let stop: (() => void) | undefined;
    const style = getComputedStyle(el);
    const fontFamily = style.getPropertyValue("--font-mono").trim() || "monospace";
    void Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      // Characters are measured once, at open: a font that arrives later would misalign the columns.
      document.fonts?.load(`13px ${fontFamily}`).catch(() => {}),
    ]).then(
      ([{ Terminal }, { FitAddon }]) => {
        if (cancelled) return;
        const background = style.getPropertyValue("--screen-bg").trim() || undefined;
        const term = new Terminal({ fontFamily, fontSize: 13, cursorBlink: true, theme: { background } });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(el);
        const fitPanel = () => {
          const d = fit.proposeDimensions();
          if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows)) return;
          const size = terminalSize(d.cols, d.rows);
          if (size.cols !== term.cols || size.rows !== term.rows) term.resize(size.cols, size.rows);
        };
        fitPanel();
        const first = terminalSize(term.cols, term.rows);
        const ws = createSocket(
          terminalSocketUrl(window.location, { orgId: org.id, agentId, ...first }),
        ) as unknown as WebSocket;
        ws.binaryType = "arraybuffer";
        // The size the computer knows: the address's, then each `resize` sent.
        let told = `${first.cols}x${first.rows}`;
        let live = false;
        let exited = false;
        let closed = false;
        const send = (bytes: Uint8Array<ArrayBuffer>) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(bytes);
        };
        const tellSize = () => {
          const size = `${term.cols}x${term.rows}`;
          if (ws.readyState !== WebSocket.OPEN || size === told) return;
          told = size;
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        };
        ws.addEventListener("open", tellSize);
        ws.addEventListener("message", (e: MessageEvent) => {
          if (typeof e.data === "string") {
            if (!isTerminalExit(e.data)) return;
            exited = true;
            setView({ state: "ended" });
            return;
          }
          term.write(new Uint8Array(e.data as ArrayBuffer));
          if (live) return;
          live = true;
          setView({ state: "live" });
          term.focus();
        });
        ws.addEventListener("close", (e: CloseEvent) => {
          closed = true;
          if (!cancelled && !exited) setView({ state: terminalCloseState(e.code, e.reason), reason: e.reason });
        });
        const utf8 = new TextEncoder();
        const subs = [
          term.onData((data) => send(utf8.encode(data))),
          // Some mouse reports aren't UTF-8: one byte per character.
          term.onBinary((data) => send(Uint8Array.from(data, (c) => c.charCodeAt(0)))),
          term.onResize(tellSize),
        ];
        const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fitPanel);
        observer?.observe(el);
        // A browser that keeps the page for its Back button can keep its sockets open there for minutes: a shell
        // nobody sees. It ends with the page, which says so if the person comes back.
        const leave = (e: PageTransitionEvent) => {
          if (e.persisted && !closed) ws.close(1000);
        };
        window.addEventListener("pagehide", leave);
        stop = () => {
          window.removeEventListener("pagehide", leave);
          observer?.disconnect();
          for (const sub of subs) sub.dispose();
          if (!closed) ws.close();
          term.dispose();
        };
      },
      () => {
        if (!cancelled) setView({ state: "dropped" });
      },
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [round, org.id, agentId, createSocket]);

  const again = (
    <Button size="sm" icon="refresh" onClick={() => setRound((r) => r + 1)}>
      {t("terminal.reopen")}
    </Button>
  );
  const cover: Record<Exclude<TerminalViewState, "live">, ReactNode> = {
    connecting: <Cover color={color} spinner text={t("terminal.state.connecting")} />,
    ended: <Cover color={color} icon="power" text={t("terminal.state.ended")} action={again} />,
    dropped: <Cover color={color} icon="alert" text={t("terminal.state.dropped")} action={again} />,
    offline: <Cover color={color} icon="alert" text={t("browser.inCard.offline", g)} action={again} />,
    busy: <Cover color={color} icon="alert" text={t("terminal.state.busy")} action={again} />,
    paused: <Cover color={color} icon="pause" text={t("desktop.state.paused", g)} action={again} />,
    forbidden: <Cover color={color} icon="lock" text={t("terminal.state.forbidden")} />,
    outdated: <Cover color={color} icon="alert" text={t("terminal.state.outdated", g)} />,
    unavailable: (
      <Cover
        color={color}
        icon="dash"
        text={t("terminal.state.unavailable", g)}
        help={view.reason === "not_allowed" ? t("browser.machine.offHelp") : undefined}
      />
    ),
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group, not a fieldset
    <div className="brw-ac is-open dsk" role="group" aria-label={t("terminal.title", g)} data-state={view.state}>
      <SkyStrip color={color} moving={false} />
      <div className="brw-ac__head">
        <span className="brw-ac__tt is-static">
          <span className="brw-ac__tx">
            <b>{t("terminal.title", g)}</b>
          </span>
        </span>
        <span className="brw-ac__acts">
          {onClose && (
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon="close"
              aria-label={t("terminal.close")}
              title={t("terminal.close")}
              onClick={onClose}
            />
          )}
        </span>
      </div>
      <div className="brw-ac__body">
        <div className="brw-ac__stage">
          <div className="trm-screen">
            <div ref={host} className="trm-host" />
          </div>
          {view.state !== "live" && cover[view.state]}
        </div>
      </div>
      <div className="brw-ac__foot">
        <span className="small muted">{t("terminal.notice", g)}</span>
      </div>
    </div>
  );
}
