import type { Message, MessageMemory } from "@agenteschat/client";
import { cacheMessageMemories, keys } from "@agenteschat/client";
import { formatTime } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { AgentReadingBook, Button, hoverPointer, Input, Popover } from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useDirectory } from "@/hooks/useDirectory";
import { lookOf } from "@/lib/look";
import { useToast } from "@/lib/toast";
import { AgentAvatar } from "./AgentAvatar";
import { useOrg } from "./org-context";

const HOVER_OPEN_MS = 250;
const HOVER_CLOSE_MS = 220;
/** The tooltip's short version of what was saved. */
const short = (text: string, n = 90) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);

/**
 * "O agente estudando": what an agent saved to its
 * memory from this person's message, as a mark at the end of the reaction
 * row: the agent reading an open pixel book. Not an emoji anyone can add:
 * squarer, raised and outlined, after a small divider. Hover: a glass card
 * "Theo guardou isso: …" (Ver na memória, Corrigir). Click: the saved fact,
 * where it came from, Corrigir (inline) and Esquecer (with Desfazer). The
 * server only sends items whoever reads the message may read.
 */
export function MemoryMarks({ message }: { message: Message }) {
  const memories = message.memories ?? [];
  if (memories.length === 0) return null;
  return (
    <>
      <span className="msg-mem__sep" aria-hidden="true" />
      {memories.slice(0, 3).map((m) => (
        <MemoryMark key={m.id} message={message} memory={m} />
      ))}
    </>
  );
}

function MemoryMark({ message, memory }: { message: Message; memory: MessageMemory }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const agent = dir.agentById.get(memory.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const canEdit = can(org, "review_memory") || agent?.ownerUserId === me.user.id;
  const [mode, setMode] = useState<"tip" | "card" | "edit" | null>(null);
  const [draft, setDraft] = useState(memory.text);
  const [active, setActive] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  // Drop a pending hover timer on unmount.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const later = (next: typeof mode, ms: number) => {
    clear();
    timer.current = setTimeout(() => {
      timer.current = null;
      setMode(next);
    }, ms);
  };

  const setMarks = (next: MessageMemory[]) => cacheMessageMemories(qc, org.id, message.channelId, message.id, next);
  const current = () => message.memories ?? [];
  const afterChange = () => void qc.invalidateQueries({ queryKey: keys.memory(org.id, memory.agentId) });

  const fix = useMutation({
    mutationFn: (text: string) => api.memory.edit(org.id, memory.id, text),
    onSuccess: (saved) => {
      // A fix is a new version: the mark now points at it.
      setMarks(current().map((m) => (m.id === memory.id ? { ...m, id: saved.id, text: saved.text } : m)));
      afterChange();
      setMode(null);
      toast.show(t("memoryMark.fixed"), "info", undefined, t("memoryMark.fixedDetail", { name }));
    },
  });
  const forget = useMutation({
    mutationFn: () => api.memory.setArchived(org.id, memory.id, true),
    onSuccess: () => {
      const before = current();
      setMarks(before.filter((m) => m.id !== memory.id));
      afterChange();
      setMode(null);
      toast.show(t("memoryMark.forgot", { name }), "info", {
        label: t("memoryMark.undo"),
        run: () => {
          void api.memory.setArchived(org.id, memory.id, false).then(() => {
            setMarks(before);
            afterChange();
          });
        },
      });
    },
  });

  const label = t("memoryMark.label", { name, text: short(memory.text) });
  const memoryLink = (
    <Button asChild size="sm" variant="ghost">
      <Link to="/org/$orgId/agents/$agentId/memory" params={{ orgId: org.id, agentId: memory.agentId }}>
        {t("memoryMark.view")}
      </Link>
    </Button>
  );
  const fixButton = canEdit ? (
    <Button
      size="sm"
      variant={mode === "card" ? "default" : "ghost"}
      icon="edit"
      onClick={() => {
        clear();
        setDraft(memory.text);
        setMode("edit");
      }}
    >
      {t("memoryMark.fix")}
    </Button>
  ) : null;

  return (
    <Popover
      open={mode !== null}
      onOpenChange={(o) => {
        clear();
        setMode(o ? "card" : null);
      }}
      label={t("memoryMark.title", { name })}
      moveFocus={mode !== "tip"}
      side={mode === "tip" ? "top" : "bottom"}
      className={mode === "tip" ? "msg-mem__tip ac-glass" : "msg-mem__pop"}
      onContentPointerEnter={(e) => hoverPointer(e.pointerType) && clear()}
      onContentPointerLeave={(e) => hoverPointer(e.pointerType) && mode === "tip" && later(null, HOVER_CLOSE_MS)}
      trigger={
        <button
          type="button"
          className="msg-mem"
          aria-label={label}
          aria-haspopup="dialog"
          onPointerEnter={(e) => {
            setActive(true);
            if (hoverPointer(e.pointerType) && mode === null) later("tip", HOVER_OPEN_MS);
          }}
          onPointerLeave={(e) => {
            setActive(false);
            if (!hoverPointer(e.pointerType)) return;
            if (mode === "tip") later(null, HOVER_CLOSE_MS);
            else if (mode === null) clear();
          }}
          onFocus={() => setActive(true)}
          onBlur={() => setActive(false)}
        >
          <AgentReadingBook appearance={lookOf(agent)} active={active} />
        </button>
      }
    >
      {mode === "tip" && (
        <div className="msg-mem__tipbody">
          <p>
            <b>{t("memoryMark.saved", { name })}</b> {short(memory.text)}
          </p>
          <div className="msg-mem__actions">
            {memoryLink}
            {fixButton}
          </div>
        </div>
      )}
      {(mode === "card" || mode === "edit") && (
        <div className="msg-mem__card">
          <div className="msg-mem__head">
            <AgentAvatar agentId={memory.agentId} name={name} size="sm" state="idle" />
            <div>
              <b>{t("memoryMark.title", { name })}</b>
              <small>{t("memoryMark.subtitle")}</small>
            </div>
          </div>
          {mode === "edit" ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const text = draft.trim();
                if (text && text !== memory.text) fix.mutate(text);
                else setMode("card");
              }}
            >
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                aria-label={t("memoryMark.fixLabel")}
                maxLength={2000}
                autoFocus
              />
              <div className="msg-mem__actions msg-mem__actions--end">
                <Button size="sm" variant="ghost" onClick={() => setMode("card")}>
                  {t("common.cancel")}
                </Button>
                <Button type="submit" size="sm" variant="primary" loading={fix.isPending}>
                  {t("memoryMark.save")}
                </Button>
              </div>
            </form>
          ) : (
            <>
              <div className="msg-mem__fact">
                <p>{memory.text}</p>
                <small>
                  {t("memoryMark.from", {
                    name: dir.authorName(message.author),
                    time: formatTime(i18n.language, message.createdAt),
                  })}
                </small>
              </div>
              <div className="msg-mem__actions">
                {fixButton}
                {canEdit && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    className="msg-mem__forget"
                    loading={forget.isPending}
                    onClick={() => forget.mutate()}
                  >
                    {t("memoryMark.forget")}
                  </Button>
                )}
                <span className="msg-mem__grow" />
                {memoryLink}
              </div>
            </>
          )}
        </div>
      )}
    </Popover>
  );
}
