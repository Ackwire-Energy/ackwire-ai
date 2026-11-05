import { type AgentColor, Mention } from "@agenteschat/ui";
import { memo, type ReactNode, useCallback, useRef } from "react";
import { ChannelRef } from "@/chat/ChannelRef";
import { splitSettled } from "@/chat/live-text";
import { ChartAccent, ChartMessage } from "@/components/ChartBlock";
import { type ChannelRenderer, Markdown, type MentionRenderer, type WikiLinkRenderer } from "@/lib/markdown";

/**
 * Renders a message body as safe Markdown (bold, italic, `code`, ```blocks```,
 * lists, links, line breaks) with @mentions (neutral, an agent's in its tone) and #channel links.
 * React elements only: HTML in a message is shown as text.
 *
 * `live` (an agent's answer still streaming): the finished blocks render once
 * and stay; only the last block re-renders as words arrive, each word fading
 * in (`.ac-word`). The final message renders without `live` but split the same
 * way: when it takes the live row's place its blocks are the same elements (a
 * selection, an open code card or a chart stay), and nothing animates again.
 */
export function MessageBody({
  body,
  resolveMention,
  mentionTone,
  renderMention,
  wikiLink,
  channelRefs,
  live,
  accent = "sky",
  pinFrom = null,
}: {
  body: string;
  resolveMention?: (handle: string) => string | null;
  /** The mentioned agent's color: its chip takes that tone. */
  mentionTone?: (handle: string) => AgentColor | undefined;
  /** Replaces the plain chip (e.g. a chip that opens the profile card). */
  renderMention?: (handle: string, key: string) => ReactNode;
  /** `[[Título]]`: wiki link chips (with a preview on hover). */
  wikiLink?: WikiLinkRenderer;
  /** The message's `meta.channelRefs`: the channel each `#name` meant when written (a renamed one still links). */
  channelRefs?: Record<string, string>;
  /** Still streaming: settled blocks memoized, the tail's words fade in. */
  live?: boolean;
  /** The writing agent's color: its charts take its tones. */
  accent?: AgentColor;
  /** An agent's saved message: its charts can be pinned to a board (ADR 0135). */
  pinFrom?: { messageId: string; agentId: string } | null;
}) {
  const mention = useCallback(
    (handle: string, key: string) =>
      renderMention ? (
        renderMention(handle, key)
      ) : (
        <Mention key={key} tone={mentionTone?.(handle)}>
          @{resolveMention?.(handle) ?? handle}
        </Mention>
      ),
    [resolveMention, mentionTone, renderMention],
  );
  const channel = useCallback<ChannelRenderer>(
    (name, text, key) => <ChannelRef key={key} name={name} text={text} refs={channelRefs} />,
    [channelRefs],
  );
  // The settled part reads the renderers through refs: a new function identity doesn't re-render it.
  const latest = useRef({ mention, wikiLink, channel });
  latest.current = { mention, wikiLink, channel };
  const stableMention = useCallback<MentionRenderer>((h, k) => latest.current.mention(h, k), []);
  const stableChannel = useCallback<ChannelRenderer>((n, text, k) => latest.current.channel(n, text, k), []);
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
  // One `.md--message` around every block, live or final: the space between blocks never changes as a block settles
  // or as the final message takes the live row's place (two wrappers had none between them).
  const { settled, tail } = splitSettled(body);
  return (
    <ChartAccent.Provider value={accent}>
      <ChartMessage.Provider value={pinFrom}>
        <div className="md md--message">
          {settled && (
            // Live: stable renderers, so a new function identity doesn't re-render it every frame. Final: the real ones
            // (a mention resolved later still shows); the swap only re-renders the same blocks.
            <SettledBlocks
              source={settled}
              mention={live ? stableMention : mention}
              channel={live ? stableChannel : channel}
              wikiLink={live ? stableWiki : wikiLink}
            />
          )}
          <Markdown
            source={tail}
            variant="message"
            mention={mention}
            channel={channel}
            wikiLink={wikiLink}
            words={live}
            bare
          />
        </div>
      </ChartMessage.Provider>
    </ChartAccent.Provider>
  );
}

/** The blocks of a streaming answer that are done: re-rendered only when another block closes. */
const SettledBlocks = memo(function SettledBlocks({
  source,
  mention,
  channel,
  wikiLink,
}: {
  source: string;
  mention: MentionRenderer;
  channel: ChannelRenderer;
  wikiLink?: WikiLinkRenderer;
}) {
  return <Markdown source={source} variant="message" mention={mention} channel={channel} wikiLink={wikiLink} bare />;
});
