import { useChannels } from "@agenteschat/client";
import { router } from "expo-router";
import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import type { ConversationRow } from "../chats/logic";
import { usePins } from "../chats/pins";
import { useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { ActionList, Tile } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { arrangesCategories, categoryHrefs, movesChannel } from "./logic";

const NO_CHANNELS: never[] = [];

/**
 * The home's long presses (ADR 0080), as short sheets: a row's "Fixar no topo" (a channel, an agent's or a person's
 * DM) and a channel's "Mover para…" (only where `movesChannel`), and a category header's Renomear, Categorias and
 * Nova categoria (admins; undefined otherwise, so the header has no long press at all).
 */
export function useCategoryMenus() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const { org } = useOrg();
  const meId = useMeId();
  const sheet = useSheet();
  const channels = useChannels(orgId).data ?? NO_CHANNELS;
  const admin = arrangesCategories(org);
  const dir = useDirectory();
  const pins = usePins();
  const go = useCallback(
    (href: Parameters<typeof router.push>[0]) => {
      sheet.close();
      router.push(href);
    },
    [sheet],
  );
  const rowMenu = (r: ConversationRow) => {
    const channel = r.kind === "channel" ? channels.find((c) => c.id === r.channelId) : undefined;
    const pin =
      r.kind === "channel"
        ? { kind: "channels" as const, id: r.channelId }
        : r.kind === "dm"
          ? { kind: r.with.type === "agent" ? ("agents" as const) : ("people" as const), id: r.with.id }
          : null;
    if (!pin || (r.kind === "channel" && !channel)) return;
    const pinned = pins.isPinned(pin.kind, pin.id);
    sheet.open(
      <>
        <SheetTitle
          {...(channel ? { leading: <Tile icon="hash" size={40} /> } : {})}
          title={channel ? `#${channel.name}` : r.kind === "dm" ? dir.nameOf(r.with) : ""}
        />
        <ActionList
          items={[
            {
              key: "pin",
              icon: "pin",
              label: pinned ? t("sidebarPins.unpin") : t("sidebarPins.pin"),
              onPress: () => {
                sheet.close();
                pins.toggle(pin.kind, pin.id);
              },
            },
            ...(channel && movesChannel(channel, meId, org)
              ? [
                  {
                    key: "move",
                    icon: "list" as const,
                    label: t("channelCategories.move"),
                    onPress: () => go(categoryHrefs.pick(channel.id)),
                  },
                ]
              : []),
          ]}
        />
      </>,
    );
  };
  const categoryMenu = (categoryId: string, name: string) => {
    if (!admin) return undefined;
    return () =>
      sheet.open(
        <>
          <SheetTitle title={name} />
          <ActionList
            items={[
              {
                key: "rename",
                icon: "pen",
                label: t("channelCategories.rename"),
                onPress: () => go(categoryHrefs.edit(categoryId)),
              },
              {
                key: "manage",
                icon: "list",
                label: t("mobile.categories.title"),
                hint: t("mobile.categories.manageHint"),
                onPress: () => go(categoryHrefs.manage),
              },
              {
                key: "new",
                icon: "plus",
                label: t("channelCategories.newCategory"),
                onPress: () => go(categoryHrefs.create()),
              },
            ]}
          />
        </>,
      );
  };
  // One function for every render (the rows are memoized), always running the latest menu.
  const latest = useRef(rowMenu);
  latest.current = rowMenu;
  const openRowMenu = useCallback((r: ConversationRow) => latest.current(r), []);
  return { openRowMenu, categoryMenu };
}
