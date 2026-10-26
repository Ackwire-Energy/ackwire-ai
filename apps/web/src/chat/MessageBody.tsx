import { type AgentColor, Mention } from "@agenteschat/ui";
import { memo, type ReactNode, useCallback, useRef } from "react";
import { splitSettled } from "@/chat/live-text";
import { ChartAccent } from "@/components/ChartBlock";
import { Markdown, type MentionRenderer, type WikiLinkRenderer } from "@/lib/markdown";

/**
 * Renders a message body as safe Markdown (bold, italic, `code`, ```blocks```,
 * lists, links, line breaks) with neutral @mentions (people and agents alike).
 * React elements only: HTML in a message is shown as text.
 *
 * `live` (an agent's answer still streaming): the finished blocks render once
 * and stay; only the last block re-renders as words arrive, each word fading
 * in (`.ac-word`). The final message renders without `live`: plain, so nothing
 * animates again when it takes the live row's place.
 */
export function MessageBody({
  body,
  resolveMention,
  renderMention,
  wikiLink,
  live,
  accent = "sky",
}: {
  body: string;
  resolveMention?: (handle: string) => string | null;
  /** Replaces the plain chip (e.g. a chip that opens the profile card). */
  renderMention?: (handle: string, key: string) => ReactNode;
  /** `[[Título]]`: wiki link chips (with a preview on hover). */
  wikiLink?: WikiLinkRenderer;
  /** Still streaming: settled blocks memoized, the tail's words fade in. */
  live?: boolean;
  /** The writing agent's color: its charts take its tones. */
  accent?: AgentColor;
}) {
  const mention = useCallback(
    (handle: string, key: string) =>
      renderMention ? renderMention(handle, key) : <Mention key={key}>@{resolveMention?.(handle) ?? handle}</Mention>,
    [resolveMention, renderMention],
  );
  // The settled part reads the renderers through refs: a new function identity doesn't re-render it.
  const latest = useRef({ mention, wikiLink });
  latest.current = { mention, wikiLink };
  const stableMention = useCallback<MentionRenderer>((h, k) => latest.current.mention(h, k), []);
  const stableWiki = useCallback<WikiLinkRenderer>(
    (title, label, k) =>
      latest.current.wikiLink ? (
        latest.current.wikiLink(title, label, k)
      ) : (
        <span key={k} className="wiki-link">
          {label}
        </span>
      ),
    [],
  );
  if (!live)
    return (
      <ChartAccent.Provider value={accent}>
        <Markdown source={body} variant="message" mention={mention} wikiLink={wikiLink} />
      </ChartAccent.Provider>
    );
  const { settled, tail } = splitSettled(body);
  return (
    <ChartAccent.Provider value={accent}>
      {settled && <SettledBlocks source={settled} mention={stableMention} wikiLink={stableWiki} />}
      <Markdown source={tail} variant="message" mention={mention} wikiLink={wikiLink} words className="md--tail" />
    </ChartAccent.Provider>
  );
}

/** The blocks of a streaming answer that are done: re-rendered only when another block closes. */
const SettledBlocks = memo(function SettledBlocks({
  source,
  mention,
  wikiLink,
}: {
  source: string;
  mention: MentionRenderer;
  wikiLink: WikiLinkRenderer;
}) {
  return <Markdown source={source} variant="message" mention={mention} wikiLink={wikiLink} />;
});
