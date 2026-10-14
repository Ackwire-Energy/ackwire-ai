import { Mention } from "@agenteschat/ui";
import { Fragment, useMemo } from "react";
import { tokenizeBody } from "./body";

/** Renders a message body: text, `code`, ```blocks``` and neutral @mentions (people and agents alike). */
export function MessageBody({
  body,
  resolveMention,
}: {
  body: string;
  resolveMention?: (handle: string) => string | null;
}) {
  const tokens = useMemo(() => tokenizeBody(body), [body]);
  return (
    <>
      {tokens.map((tok, i) => {
        const key = `${tok.type}-${i}`;
        switch (tok.type) {
          case "code":
            return <code key={key}>{tok.text}</code>;
          case "codeblock":
            return (
              <pre key={key}>
                <code>{tok.text}</code>
              </pre>
            );
          case "mention": {
            const name = resolveMention?.(tok.handle);
            return <Mention key={key}>@{name ?? tok.handle}</Mention>;
          }
          default:
            return <Fragment key={key}>{tok.text}</Fragment>;
        }
      })}
    </>
  );
}
