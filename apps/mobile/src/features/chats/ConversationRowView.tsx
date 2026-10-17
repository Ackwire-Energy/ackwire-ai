import { router } from "expo-router";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Count, Row, Text } from "@/ui";
import { chatHref } from "../links/logic";
import { Face } from "../shared/Face";
import { useDirectory, useWhen } from "../shared/hooks";
import { Tile } from "../shared/parts";
import type { ConversationRow, LastLine } from "./logic";

/**
 * One conversation in a list: channels with # ("Nome: last", else the
 * topic), DMs with the face, threads with the reply tile ("#canal · last"),
 * missions with the target tile; unread as a Doto badge.
 * Faces are still frames (long list).
 */
export const ConversationRowView = memo(function ConversationRowView({
  row: r,
  divider = false,
}: {
  row: ConversationRow;
  /** A hairline above (every row but the first in a card). */
  divider?: boolean;
}) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const when = useWhen();
  const lastText = (last: LastLine | null) => {
    if (!last) return "";
    const who = last.name || (last.author ? dir.nameOf(last.author) : "");
    return who ? `${who}: ${last.text}` : last.text;
  };
  const leading =
    r.kind === "dm" ? (
      <Face who={{ type: r.with.type, id: r.with.id }} size={36} live={false} />
    ) : (
      <Tile icon={r.kind === "channel" ? "hash" : r.kind === "mission" ? "target" : "reply"} />
    );
  const title = r.kind === "channel" ? `#${r.name}` : r.kind === "dm" ? r.with.name : r.title;
  const subtitle =
    r.kind === "channel"
      ? lastText(r.last) || r.topic
      : r.kind === "dm"
        ? lastText(r.last)
        : [
            r.closed ? t("mobile.chats.closed") : null,
            r.channelKind === "dm" ? r.channelName : `#${r.channelName}`,
            r.working
              ? t("mobile.chats.working")
              : r.mission
                ? t("mobile.chats.missionProgress", { done: r.mission.planDone, total: r.mission.planTotal })
                : lastText(r.last),
          ]
            .filter(Boolean)
            .join(" · ");
  const meta =
    r.at || r.unread > 0 ? (
      <>
        {r.at ? (
          <Text variant="caption" tone="faint">
            {when.short(r.at)}
          </Text>
        ) : null}
        {r.unread > 0 ? <Count value={r.unread} max={99} inverted /> : null}
      </>
    ) : undefined;
  return (
    <Row
      divider={divider}
      leading={leading}
      title={title}
      {...(subtitle ? { subtitle } : {})}
      {...(meta ? { meta } : {})}
      onPress={() =>
        router.push(chatHref(r.channelId, r.kind === "thread" || r.kind === "mission" ? r.threadId : null))
      }
    />
  );
});
