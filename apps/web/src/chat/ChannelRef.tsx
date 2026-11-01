import { useChannelCard, useChannels, useJoinChannel } from "@agenteschat/client";
import { resolveChannelRef } from "@agenteschat/client/lib/channel-refs";
import { Button, Chip, hoverPointer, Icon, Popover } from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FocusEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { HOVER_OPEN_MS } from "@/components/ProfileCard";

const HOVER_CLOSE_MS = 200;

/**
 * `#name` in a message: a link to the channel it means (`resolveChannelRef`), with its card on hover or keyboard
 * focus. A channel the viewer can't see stays the text as written; an archived one opens only its card.
 */
export function ChannelRef({ name, text, refs }: { name: string; text: string; refs?: Record<string, string> }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const channels = useChannels(org.id).data ?? [];
  const ref = resolveChannelRef(name, refs, channels);
  // A channel the list doesn't have (archived, or not mine): only the server knows if it may show.
  const lookup = useChannelCard(org.id, ref?.id ?? "", Boolean(ref && !ref.known));
  const [open, setOpen] = useState<false | "hover" | "press">(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const later = (next: boolean, ms: number) => {
    clear();
    timer.current = setTimeout(() => {
      timer.current = null;
      setOpen(next && "hover");
    }, ms);
  };
  if (!ref || (!ref.known && !lookup.data)) return <>{text}</>;
  const shown = ref.known?.name ?? lookup.data?.name ?? name;
  const archived = !ref.known && lookup.data?.archived === true;
  const label = archived ? t("channelRefs.archivedLabel", { name: shown }) : t("channelRefs.label", { name: shown });
  const hover = {
    onPointerEnter: (e: PointerEvent) => {
      if (hoverPointer(e.pointerType) && !open) later(true, HOVER_OPEN_MS);
    },
    onPointerLeave: (e: PointerEvent) => {
      if (!hoverPointer(e.pointerType)) return;
      if (open) later(false, HOVER_CLOSE_MS);
      else clear();
    },
    // Keyboard focus shows the card too; the focus stays on the link (Enter opens the channel).
    onFocus: (e: FocusEvent<HTMLElement>) => {
      if (!open && e.currentTarget.matches(":focus-visible")) setOpen("hover");
    },
    onBlur: () => {
      if (open === "hover") later(false, HOVER_CLOSE_MS);
    },
  };
  const className = archived ? "channel-ref channel-ref--archived" : "channel-ref";
  return (
    <Popover
      open={open !== false}
      onOpenChange={(o) => {
        clear();
        setOpen(o && "press");
      }}
      moveFocus={open === "press"}
      label={t("channelRefs.card", { name: shown })}
      side="bottom"
      className="profile-card channel-card"
      onContentPointerEnter={(e) => hoverPointer(e.pointerType) && clear()}
      onContentPointerLeave={(e) => hoverPointer(e.pointerType) && later(false, HOVER_CLOSE_MS)}
      trigger={
        archived ? (
          <button type="button" className={className} aria-label={label} aria-haspopup="dialog" {...hover}>
            #{shown}
          </button>
        ) : (
          // The link navigates (and so keeps the card closed: a prevented click never toggles it).
          <Link
            to="/org/$orgId/c/$channelId"
            params={{ orgId: org.id, channelId: ref.id }}
            className={className}
            aria-label={label}
            {...hover}
          >
            #{shown}
          </Link>
        )
      }
    >
      {open && <ChannelCardBody channelId={ref.id} onDone={() => setOpen(false)} />}
    </Popover>
  );
}

function ChannelCardBody({ channelId, onDone }: { channelId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const card = useChannelCard(org.id, channelId);
  const join = useJoinChannel(org.id, channelId);
  const c = card.data;
  if (!c) return <p className="small muted">{card.isError ? t("channelRefs.gone") : t("channelRefs.loading")}</p>;
  const openIt = () => {
    onDone();
    void navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: org.id, channelId } });
  };
  return (
    <div className="profile-card__body">
      <div className="channel-card__head">
        <Icon name={c.archived ? "archive" : c.visibility === "private" ? "lock" : "channel"} size={16} />
        <span className="profile-card__name">#{c.name}</span>
        {c.archived && <Chip>{t("channelRefs.archived")}</Chip>}
      </div>
      {c.topic && <p className="channel-card__topic">{c.topic}</p>}
      <p className="small muted channel-card__facts">
        {[
          t("channelRefs.people", { count: c.people }),
          t("channelRefs.agents", { count: c.agents }),
          c.isMember ? t("channelRefs.member") : t("channelRefs.notMember"),
        ].join(" · ")}
      </p>
      {!c.archived && (
        <div className="profile-card__actions">
          {!c.isMember && c.visibility === "public" && (
            <Button
              size="sm"
              variant="primary"
              loading={join.isPending}
              onClick={() => join.mutate(undefined, { onSuccess: openIt })}
            >
              {t("channelRefs.join")}
            </Button>
          )}
          <Button size="sm" onClick={openIt}>
            {t("channelRefs.open")}
          </Button>
        </div>
      )}
    </div>
  );
}
