import { Mention } from "@agenteschat/ui";
import { useCallback } from "react";
import { Markdown } from "@/lib/markdown";

/**
 * Renders a message body as safe Markdown (bold, italic, `code`, ```blocks```,
 * lists, links, line breaks) with neutral @mentions (people and agents alike).
 * React elements only: HTML in a message is shown as text.
 */
export function MessageBody({
  body,
  resolveMention,
}: {
  body: string;
  resolveMention?: (handle: string) => string | null;
}) {
  const mention = useCallback(
    (handle: string, key: string) => <Mention key={key}>@{resolveMention?.(handle) ?? handle}</Mention>,
    [resolveMention],
  );
  return <Markdown source={body} variant="message" mention={mention} />;
}
