import type { Agent, Channel, Member } from "@agenteschat/client";
import { Icon } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { ChannelMembersButton } from "@/components/ChannelMembers";
import { ChannelPinsButton } from "@/components/ChannelPins";
import { useChannelMenu } from "@/components/entity-menus";
import { NavToggle } from "@/components/NavDrawer";
import { HeaderSearch } from "@/components/search/HeaderSearch";
import { ChannelThreadsButton } from "@/components/threads/ThreadLines";
import { entityMenu } from "@/lib/entity-menu";
import "./channel-header.css";

/**
 * A channel's header, as Discord's: `#` and the name, the topic beside it while it fits whole, then icon buttons
 * (threads with their count, pins, the channel's settings, members) and the workspace search.
 */
export function ChannelHeader({
  channel,
  isMember,
  people,
  agents,
  onDetails,
  onSearch,
}: {
  channel: Channel;
  isMember: boolean;
  people: Member[];
  agents: Agent[];
  /** The cog: the channel's details dialog (description, members, archive…). */
  onDetails: () => void;
  /** Enter in the search: its results in the panel. */
  onSearch: () => void;
}) {
  const { t } = useTranslation();
  const channelEntries = useChannelMenu();
  const settings = t("shell.sidebarMenu.channelSettings");
  return (
    <header className="channel__header">
      <NavToggle />
      <div className="channel__head-text" {...entityMenu(() => channelEntries(channel))}>
        <h1 className="channel__title">
          <Icon name="channel" className="channel__title-hash" />
          <span>{channel.name}</span>
        </h1>
        {channel.topic && <span className="channel__topic">{channel.topic}</span>}
      </div>
      <div className="channel__acts">
        {isMember && <ChannelThreadsButton channelId={channel.id} channelName={channel.name} />}
        {isMember && <ChannelPinsButton channelId={channel.id} channelName={channel.name} />}
        <button
          type="button"
          className="ac-btn ac-btn--ghost ac-btn--icon channel__icon channel__cog"
          aria-label={settings}
          title={settings}
          onClick={onDetails}
        >
          <Icon name="cog" />
        </button>
        <ChannelMembersButton channelId={channel.id} people={people} agents={agents} onDetails={onDetails} />
        {isMember && <HeaderSearch onOpen={onSearch} />}
      </div>
    </header>
  );
}
