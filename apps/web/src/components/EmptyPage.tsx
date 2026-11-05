import { useChannels } from "@agenteschat/client";
import { Button, EmptyState, type IconName, PageHeader } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "./org-context";

/**
 * Designed empty state for screens the design only links to (thread, DMs,
 * issues, Drive, search, settings): page title, a dashed box with the
 * icon and a short explanation, and a way back to the conversation.
 */
export function EmptyPage({
  icon,
  title,
  text,
  children,
}: {
  icon: IconName;
  title: string;
  text: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const channels = useChannels(org.id);
  const home = channels.data?.find((c) => c.name === "general" && c.isMember) ?? channels.data?.find((c) => c.isMember);
  return (
    <div className="page page--mid">
      <PageHeader title={title} />
      {children}
      <EmptyState
        sky
        icon={icon}
        title={t("empty.soon")}
        actions={
          home && (
            <Button asChild>
              <Link to="/org/$orgId/c/$channelId" params={{ orgId: org.id, channelId: home.id }}>
                {t("empty.goToChannel", { channel: home.name })}
              </Link>
            </Button>
          )
        }
      >
        {text}
      </EmptyState>
    </div>
  );
}
