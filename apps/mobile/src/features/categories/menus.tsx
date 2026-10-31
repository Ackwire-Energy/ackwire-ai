import { useChannels } from "@agenteschat/client";
import { router } from "expo-router";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { useMeId, useOrgId } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { ActionList, Tile } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { arrangesCategories, categoryHrefs, movesChannel } from "./logic";

const NO_CHANNELS: never[] = [];

/**
 * The home's long presses (ADR 0080), as short sheets: a channel's "Mover para…" (only where `movable`), and a
 * category header's Renomear, Categorias and Nova categoria (admins; undefined otherwise, so the header has no
 * long press at all).
 */
export function useCategoryMenus() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const { org } = useOrg();
  const meId = useMeId();
  const sheet = useSheet();
  const channels = useChannels(orgId).data ?? NO_CHANNELS;
  const admin = arrangesCategories(org);
  const go = useCallback(
    (href: Parameters<typeof router.push>[0]) => {
      sheet.close();
      router.push(href);
    },
    [sheet],
  );
  /** Whether the long press on this channel's row has anything to offer. */
  const movable = (channelId: string) => {
    const channel = channels.find((c) => c.id === channelId);
    return channel ? movesChannel(channel, meId, org) : false;
  };
  // Stable across renders (rows are memoized): it changes only when the channels or who you are change.
  const openChannelMenu = useCallback(
    (channelId: string) => {
      const channel = channels.find((c) => c.id === channelId);
      if (!channel) return;
      sheet.open(
        <>
          <SheetTitle leading={<Tile icon="hash" size={40} />} title={`#${channel.name}`} />
          <ActionList
            items={[
              {
                key: "move",
                icon: "list",
                label: t("channelCategories.move"),
                onPress: () => go(categoryHrefs.pick(channelId)),
              },
            ]}
          />
        </>,
      );
    },
    [channels, sheet, t, go],
  );
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
  return { movable, openChannelMenu, categoryMenu };
}
