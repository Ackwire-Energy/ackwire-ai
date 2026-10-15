import { Button, Dialog, DialogBody, DialogFooter, Field, Icon, Reaction, Reactions, Textarea } from "@agenteschat/ui";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCorrectMessage, useReactions, useToggleReaction } from "@/api/queries";
import type { ReactionCount } from "@/api/types";
import { agentGrammar } from "@/lib/grammar";
import { useToast } from "@/lib/toast";
import { useOrg } from "./org-context";

const UP = "+1";
const DOWN = "-1";

/** Whether I reacted with `reaction`, and how many did. */
export function reactionState(list: ReactionCount[] | undefined, reaction: string, userId: string) {
  const r = list?.find((x) => x.reaction === reaction);
  return { mine: Boolean(r?.userIds.includes(userId)), count: r?.count ?? 0 };
}

/**
 * 👍/👎 and "Corrigir resposta" on an agent reply. Both feed the agent's
 * learning (phase 5). Shown on hover or keyboard focus, always reachable with Tab.
 */
export function MessageFeedback({
  messageId,
  agentName,
  active,
  more,
}: {
  messageId: string;
  agentName: string;
  /** The row was hovered or focused: load the reactions. */
  active: boolean;
  /** The "…" menu (Salvar na wiki, Copiar link, Responder em thread). */
  more?: ReactNode;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const reactions = useReactions(org.id, messageId, active);
  const toggle = useToggleReaction(org.id, messageId);
  const [correcting, setCorrecting] = useState(false);
  const up = reactionState(reactions.data, UP, me.user.id);
  const down = reactionState(reactions.data, DOWN, me.user.id);

  const press = (reaction: string, mine: boolean, other: { reaction: string; mine: boolean }) => {
    // One opinion at a time: 👍 replaces 👎 and vice versa.
    if (!mine && other.mine) toggle.mutate({ reaction: other.reaction, on: false });
    toggle.mutate({ reaction, on: !mine });
  };

  return (
    <>
      <div
        className="ac-msg__actions"
        role="toolbar"
        aria-label={t("channel.actions", { name: agentName })}
        data-open={correcting}
      >
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("channel.helpful")}
          aria-pressed={up.mine}
          disabled={toggle.isPending}
          onClick={() => press(UP, up.mine, { reaction: DOWN, mine: down.mine })}
        >
          <Icon name="thumbUp" size={16} />
          {up.count > 0 && <span className="ac-msg__reaction-count">{up.count}</span>}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("channel.notHelpful")}
          aria-pressed={down.mine}
          disabled={toggle.isPending}
          onClick={() => press(DOWN, down.mine, { reaction: UP, mine: up.mine })}
        >
          <Icon name="thumbDown" size={16} />
          {down.count > 0 && <span className="ac-msg__reaction-count">{down.count}</span>}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="edit"
          aria-label={t("channel.correct")}
          onClick={() => setCorrecting(true)}
        />
        {more}
      </div>
      <CorrectionDialog open={correcting} onOpenChange={setCorrecting} messageId={messageId} agentName={agentName} />
    </>
  );
}

function CorrectionDialog({
  open,
  onOpenChange,
  messageId,
  agentName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messageId: string;
  agentName: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const correct = useCorrectMessage(org.id);
  const [text, setText] = useState("");
  const g = agentGrammar(t, agentName);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setText("");
      }}
      title={t("channel.correctTitle", g)}
      closeLabel={t("common.close")}
      width={480}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          correct.mutate(
            { messageId, body: text.trim() },
            {
              onSuccess: () => {
                toast.show(t("channel.correctionSent", g));
                setText("");
                onOpenChange(false);
              },
            },
          );
        }}
      >
        <DialogBody>
          <Field label={t("channel.correctLabel")} id={`correct-${messageId}`} help={t("channel.correctHelp", g)}>
            <Textarea
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("channel.correctPlaceholder")}
              autoFocus
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!text.trim() || correct.isPending}
            loading={correct.isPending}
          >
            {t("channel.sendCorrection")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/**
 * Reaction pills under an agent reply (only when someone reacted). Counts
 * come from the message list (`message.reactions`, when the server sends
 * them) or from the reactions already loaded on hover.
 */
export function ReactionPills({ messageId, initial }: { messageId: string; initial?: ReactionCount[] }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const loaded = useReactions(org.id, messageId, false);
  const toggle = useToggleReaction(org.id, messageId);
  const list = loaded.data ?? initial;
  const up = reactionState(list, UP, me.user.id);
  const down = reactionState(list, DOWN, me.user.id);
  if (up.count === 0 && down.count === 0) return null;
  const press = (reaction: string, mine: boolean, other: { reaction: string; mine: boolean }) => {
    if (!mine && other.mine) toggle.mutate({ reaction: other.reaction, on: false });
    toggle.mutate({ reaction, on: !mine });
  };
  return (
    <Reactions label={t("channel.reactions")}>
      {up.count > 0 && (
        <Reaction
          pressed={up.mine}
          count={up.count}
          label={t("channel.reactionCount", { name: t("channel.helpful"), count: up.count })}
          onClick={() => press(UP, up.mine, { reaction: DOWN, mine: down.mine })}
        >
          <Icon name="thumbUp" size={14} />
        </Reaction>
      )}
      {down.count > 0 && (
        <Reaction
          pressed={down.mine}
          count={down.count}
          label={t("channel.reactionCount", { name: t("channel.notHelpful"), count: down.count })}
          onClick={() => press(DOWN, down.mine, { reaction: UP, mine: up.mine })}
        >
          <Icon name="thumbDown" size={14} />
        </Reaction>
      )}
    </Reactions>
  );
}
