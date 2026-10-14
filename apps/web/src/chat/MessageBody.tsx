import { Mention } from "@agenteschat/ui";
import { type ReactNode, useCallback } from "react";
import { Markdown } from "@/lib/markdown";

/**
 * Renders a message body as safe Markdown (bold, italic, `code`, ```blocks```,
 * lists, links, line breaks) with neutral @mentions (people and agents alike).
 * React elements only: HTML in a message is shown as text.
 */
export function MessageBody({
  body,
  resolveMention,
  renderMention,
}: {
  body: string;
  resolveMention?: (handle: string) => string | null;
  /** Replaces the plain chip (e.g. a chip that opens the profile card). */
  renderMention?: (handle: string, key: string) => ReactNode;
}) {
  const mention = useCallback(
    (handle: string, key: string) =>
      renderMention ? renderMention(handle, key) : <Mention key={key}>@{resolveMention?.(handle) ?? handle}</Mention>,
    [resolveMention, renderMention],
  );
  return <Markdown source={body} variant="message" mention={mention} />;
}
