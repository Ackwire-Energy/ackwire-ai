import { Button, Icon } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";

/** A channel's or DM's header: search only this conversation (the search page with an `in:` chip, ADR 0123). */
export function SearchHereButton({ channelId }: { channelId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const label = t("searchPage.searchHere");
  return (
    <Button asChild size="sm" iconOnly>
      <Link
        to="/org/$orgId/search"
        params={{ orgId: org.id }}
        search={{ in: channelId }}
        aria-label={label}
        title={label}
      >
        <Icon name="search" />
      </Link>
    </Button>
  );
}
