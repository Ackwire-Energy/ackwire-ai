import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import type { StickerLook, StickerMood } from "@agenteschat/ui/agent/stickers";
import { useTranslation } from "react-i18next";
import { Button, EmptyState, type EmptyStateProps, type IconName } from "@/ui";
import { type EmptyPlace, firstUseCopy } from "./first-use";
import { useDirectory } from "./hooks";
import { agentLook } from "./logic";

/** Who stands over an empty place when it has no agent of its own: the right hand, else the default look. */
export function useEmptyLook(): StickerLook | true {
  const lodi = rightHandOf(useDirectory().agents);
  return lodi ? agentLook(lodi) : true;
}

/**
 * A place with nothing in it yet: the agent, its words, and the first step. With `acts` false the button is gone
 * (the server would refuse it) and the words say who does it.
 */
export function FirstUse({
  place,
  acts,
  label,
  onPress,
  icon = "plus",
  busy = false,
  size = "page",
  look,
  mood,
}: {
  place: EmptyPlace;
  acts: boolean;
  label?: string | undefined;
  onPress?: (() => void) | undefined;
  icon?: IconName;
  busy?: boolean;
  size?: EmptyStateProps["size"];
  look?: StickerLook;
  mood?: StickerMood;
}) {
  const { t } = useTranslation();
  const fallback = useEmptyLook();
  const copy = firstUseCopy(place, acts);
  return (
    <EmptyState
      size={size}
      agent={look ?? fallback}
      {...(mood ? { mood } : {})}
      title={t(copy.title)}
      subtitle={t(copy.text)}
      {...(acts && label && onPress
        ? {
            action: <Button variant="primary" size="sm" icon={icon} label={label} loading={busy} onPress={onPress} />,
          }
        : {})}
    />
  );
}
