import { useArtifact, useBlockReply, useKeepBlock } from "@agenteschat/client";
import {
  type BlockEvent,
  type BlockHost,
  blockEvent,
  blockPage,
  DRAFT_SETTLE_MS,
} from "@agenteschat/client/lib/blocks";
import { PAGE_SANDBOX } from "@agenteschat/client/lib/isolated-page";
import { Button, Menu, MenuItem, Spinner } from "@agenteschat/ui";
import { chartRamp } from "@agenteschat/ui/sky/chart";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePageUrl } from "@/components/artifacts/HtmlFrame";
import { useArtifactViewer } from "@/components/artifacts/ArtifactViewer";
import { useOrg } from "@/components/org-context";
import { CardSky, colorOf } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";
import { useDarkTheme } from "@/lib/grow";
import { useToast } from "@/lib/toast";
import "./blocks.css";

/** Taller than this and a block scrolls inside the card; "Abrir grande" shows it all. */
const INLINE_MAX_HEIGHT = 640;

/** What stays when a frame goes away (scrolled out, opened big): the same block comes back as it was. */
const kept = new Map<string, { state?: Record<string, unknown>; height?: number; sent?: { text: string; at: string } }>();
const keptOf = (key: string) => {
  const found = kept.get(key);
  if (found) return found;
  const fresh = {};
  kept.set(key, fresh);
  return fresh as { state?: Record<string, unknown>; height?: number; sent?: { text: string; at: string } };
};

/** Our font for a block, inlined: it has no network. Loaded once, and a block just uses the system's if it fails. */
let fontFace: Promise<string> | null = null;
function loadFontFace() {
  fontFace ??= import("@fontsource-variable/onest/files/onest-latin-wght-normal.woff2?inline")
    .then(
      (m: { default: string }) =>
        `@font-face{font-family:Onest;font-weight:100 900;font-display:swap;src:url(${m.default}) format("woff2")}`,
    )
    .catch(() => "");
  return fontFace;
}

/** Close to the viewport, with room to spare: a long conversation keeps only the frames near what is on screen. */
function useNearScreen<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(typeof IntersectionObserver !== "function");
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== "function") return;
    const seen = new IntersectionObserver(([e]) => setNear(e?.isIntersecting ?? true), { rootMargin: "600px 0px" });
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  return { ref, near };
}

/** The sandboxed frame: the page, how tall it says it is, what it proposes. */
function BlockFrame({
  blockKey,
  html,
  title,
  color,
  maxHeight,
  onEvent,
  onFailed,
}: {
  blockKey: string;
  html: string;
  title: string;
  color: Parameters<typeof chartRamp>[0];
  maxHeight: number;
  onEvent: (e: BlockEvent) => void;
  onFailed: () => void;
}) {
  const { i18n, t } = useTranslation();
  const dark = useDarkTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const [face, setFace] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [height, setHeight] = useState(keptOf(blockKey).height ?? 0);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    let alive = true;
    void loadFontFace().then((css) => {
      if (alive) setFace(css);
    });
    return () => {
      alive = false;
    };
  }, []);

  // The page is built once per block: a new theme is sent to it, and a rebuild would lose what the person set.
  const page = useMemo(() => {
    if (face === null) return null;
    const host: BlockHost = {
      theme: dark ? "dark" : "light",
      ramp: chartRamp(color),
      locale: i18n.language,
      labels: { send: t("blocks.send"), more: t("blocks.more"), thousand: t("blocks.thousand") },
      state: keptOf(blockKey).state,
      fontFace: face,
    };
    return blockPage(html, host);
    // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  }, [face, html, blockKey]);

  const { url, failed } = usePageUrl(page ?? "", ready);
  useEffect(() => {
    if (failed) onFailed();
  }, [failed, onFailed]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const event = blockEvent(e.data);
      if (!event) return;
      if (event.type === "ready") setReady(true);
      if (event.type === "height") {
        keptOf(blockKey).height = event.height;
        setHeight(event.height);
      }
      if (event.type === "state") keptOf(blockKey).state = event.state;
      onEventRef.current(event);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [blockKey]);

  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ theme: dark ? "dark" : "light" }, "*");
  }, [dark]);

  if (!page || !url) return <div className="live-block__room" style={{ height: height || 120 }} />;
  return (
    <iframe
      ref={frame}
      className="live-block__frame"
      src={url}
      title={title}
      sandbox={PAGE_SANDBOX}
      referrerPolicy="no-referrer"
      style={{ height: Math.min(height || 120, maxHeight) }}
    />
  );
}

/**
 * A live block (ADR 0113): the agent's page in its frame, and under it, outside the frame, what would go back to the
 * agent and the button that sends it. The page only proposes: it can't reach this button, and the person reads the
 * text before it goes.
 */
export function LiveBlock({
  id,
  version,
  title,
  html,
  agentId,
  big = false,
}: {
  id: string;
  version: number;
  title: string;
  html: string;
  agentId: string;
  big?: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agent = dir.anyAgent(agentId);
  const blockKey = `${id}@${version}`;
  const { ref, near } = useNearScreen<HTMLDivElement>();
  const [draft, setDraft] = useState<Extract<BlockEvent, { type: "draft" }> | null>(null);
  const [broken, setBroken] = useState(false);
  const [sent, setSent] = useState(keptOf(blockKey).sent ?? null);
  const changedAt = useRef(0);
  const reply = useBlockReply(org.id, id);
  const toast = useToast();

  const say = (text: string, then?: () => void) =>
    reply.mutate(
      { text, clientId: crypto.randomUUID() },
      { onSuccess: then, onError: () => toast.show(t("blocks.sendFailed"), "error") },
    );

  const onEvent = (e: BlockEvent) => {
    if (e.type !== "draft") return;
    setDraft((old) => {
      if (old?.text !== e.text) changedAt.current = Date.now();
      return e;
    });
  };

  const send = () => {
    if (!draft?.ready || reply.isPending) return;
    // A page can't swap the words under a click: a text that just changed needs a moment on screen.
    if (Date.now() - changedAt.current < DRAFT_SETTLE_MS) return;
    const text = draft.text;
    say(text, () => {
      const done = { text, at: new Date().toISOString() };
      keptOf(blockKey).sent = done;
      setSent(done);
    });
  };

  if (broken) {
    return (
      <div className="live-block__broken">
        <span>
          <b>{t("blocks.brokenTitle")}</b>
          <small>{t("blocks.brokenBody")}</small>
        </span>
        <Button variant="secondary" size="sm" disabled={reply.isPending} onClick={() => say(t("blocks.retryText"))}>
          {t("blocks.retry")}
        </Button>
      </div>
    );
  }

  const same = sent !== null && sent.text === draft?.text;
  return (
    <div ref={ref}>
      {near || big ? (
        <BlockFrame
          blockKey={blockKey}
          html={html}
          title={title}
          color={colorOf(agent)}
          maxHeight={big ? 100_000 : INLINE_MAX_HEIGHT}
          onEvent={onEvent}
          onFailed={() => setBroken(true)}
        />
      ) : (
        <div
          className="live-block__room"
          style={{ height: Math.min(keptOf(blockKey).height ?? 120, INLINE_MAX_HEIGHT) }}
        />
      )}
      {same ? (
        <div className="live-block__foot">
          <span className="live-block__sent">
            <span className="live-block__mark" aria-hidden="true" />
            {t("blocks.sentAt", { time: new Date(sent.at).toLocaleTimeString([], { timeStyle: "short" }) })}
          </span>
        </div>
      ) : draft ? (
        <div className="live-block__foot">
          <span className="live-block__draft">
            {draft.ready ? (
              <>
                {t("blocks.goesTo", { name: agent?.name ?? t("channel.unknownAgent") })} <b>{draft.text}</b>
              </>
            ) : (
              draft.hint
            )}
          </span>
          <Button variant="primary" size="sm" disabled={!draft.ready || reply.isPending} onClick={send}>
            {draft.label}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** A block on its message: the agent's card, its title, and the block itself. */
export function LiveBlockCard({ id, version }: { id: string; version?: number }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const viewer = useArtifactViewer();
  const query = useArtifact(org.id, id, version);
  const keep = useKeepBlock(org.id, id);
  const toast = useToast();
  const a = query.data;
  if (!a || a.content.kind !== "block") {
    return (
      <div className="live-block live-block--loading" aria-busy="true">
        <Spinner />
        <span>{t("blocks.building")}</span>
      </div>
    );
  }
  const agentId = a.createdBy.id;
  const subtitle = a.inDrive ? t("blocks.inDrive") : a.content.subtitle;
  return (
    <section className="live-block" aria-label={a.title}>
      <CardSky color={colorOf(dir.anyAgent(agentId))} />
      <header className="live-block__head">
        <span className="live-block__titles">
          <b>{a.title}</b>
          {subtitle && <small>{subtitle}</small>}
        </span>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="expand"
          aria-label={t("blocks.openBig")}
          title={t("blocks.openBig")}
          onClick={() => viewer.open(a.id)}
        />
        <Menu
          align="end"
          label={t("blocks.more")}
          trigger={<Button variant="ghost" size="sm" iconOnly icon="more" aria-label={t("blocks.more")} />}
        >
          <MenuItem
            icon="drive"
            disabled={a.inDrive || keep.isPending}
            onSelect={() => keep.mutate(undefined, { onSuccess: () => toast.show(t("blocks.kept")) })}
          >
            {a.inDrive ? t("blocks.inDrive") : t("blocks.keep")}
          </MenuItem>
        </Menu>
      </header>
      <LiveBlock id={a.id} version={a.shownVersion} title={a.title} html={a.content.html} agentId={agentId} />
    </section>
  );
}
