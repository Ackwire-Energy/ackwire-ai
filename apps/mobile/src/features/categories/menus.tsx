import { useChannels } from "@agenteschat/client";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { useMeId, useOrgId } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { ActionList, Tile } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { arrangesCategories, categoryHrefs, movesChannel } from "./logic";

/**
 * The home's long presses (ADR 0080), as short sheets: a channel's "Mover para…" (who may move it), and a
 * category header's Renomear, Categorias and Nova categoria (admins). Each returns undefined when there is
 * nothing to offer, so the row has no long press at all.
 */
export function useCategoryMenus() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const { org } = useOrg();
  const meId = useMeId();
  const sheet = useSheet();
  const channels = useChannels(orgId).data ?? [];
  const admin = arrangesCategories(org?.role);
  const go = (href: Parameters<typeof router.push>[0]) => {
    sheet.close();
    router.push(href);
  };
  const channelMenu = (channelId: string) => {
    const channel = channels.find((c) => c.id === channelId);
    if (!channel || !movesChannel(channel, meId, org?.role)) return undefined;
    return () =>
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
  return { channelMenu, categoryMenu };
}
