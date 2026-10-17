import type { ForumTopicDetail } from "@agenteschat/client";
import { useForumAction } from "@agenteschat/client";
import { canTalk } from "@agenteschat/client/lib/audience";
import { isEnded, ownerOf, seatsOf } from "@agenteschat/client/lib/forum";
import { Avatar, Button, Checkbox, Dialog, DialogBody, DialogFooter, Icon, SearchInput, Switch } from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { useForumWho } from "./pieces";

const diff = (now: string[], before: string[]) => ({
  add: now.filter((x) => !before.includes(x)),
  remove: before.filter((x) => !now.includes(x)),
});

/**
 * "Participantes": who sits at the table (in order), who was notified, and
 * that the whole organization reads. "Editar" adds or removes agents and
 * people and sits people down (`PUT …/participants` with the difference).
 */
export function ParticipantsDialog({
  topic,
  open,
  onClose,
}: {
  topic: ForumTopicDetail;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const who = useForumWho();
  const toast = useToast();
  const action = useForumAction(org.id);
  const [editing, setEditing] = useState(false);
  const [q, setQ] = useState("");
  const seatedBefore = topic.seats.filter((s) => s.type === "person").map((s) => s.id);
  const [agentIds, setAgentIds] = useState<string[]>(topic.agentIds);
  const [userIds, setUserIds] = useState<string[]>(topic.userIds);
  const [seated, setSeated] = useState<string[]>(seatedBefore);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset to the topic each time it opens
  useEffect(() => {
    if (!open) return;
    setEditing(false);
    setQ("");
    setAgentIds(topic.agentIds);
    setUserIds(topic.userIds);
    setSeated(topic.seats.filter((s) => s.type === "person").map((s) => s.id));
  }, [open]);
  const query = q.trim().toLowerCase();
  const owner = ownerOf(topic);
  const seats = seatsOf(topic);
  const spoke = (id: string) => topic.posts.some((p) => p.author.type === "person" && p.author.id === id);
  const shown = (name: string) => !query || name.toLowerCase().includes(query);
  const a = diff(agentIds, topic.agentIds);
  const u = diff(userIds, topic.userIds);
  const s = diff(seated, seatedBefore);
  const changed = a.add.length + a.remove.length + u.add.length + u.remove.length + s.add.length + s.remove.length > 0;
  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...new Set([...list, id])] : list.filter((x) => x !== id);
  const save = () =>
    action.mutate(
      {
        type: "participants",
        topicId: topic.id,
        input: {
          addAgentIds: a.add,
          removeAgentIds: a.remove,
          addUserIds: u.add,
          removeUserIds: u.remove,
          seatUserIds: s.add,
          unseatUserIds: s.remove,
        },
      },
      {
        onSuccess: () => {
          toast.show(t("forum.participantsDialog.saved"));
          onClose();
        },
      },
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("forum.participantsDialog.title")}
      description={t("forum.participantsDialog.text", {
        agents: topic.agentIds.length,
        people: t("forum.participantsDialog.people", { count: topic.userIds.length }),
      })}
      closeLabel={t("common.close")}
      width={520}
    >
      {!editing ? (
        <DialogBody>
          <SearchInput
            aria-label={t("forum.participantsDialog.search")}
            placeholder={t("forum.participantsDialog.search")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <ul className="forum-plist">
            {seats.map((seat, i) => {
              const name = who.seatName(seat);
              if (!shown(name)) return null;
              const role = seat.type === "agent" ? who.dir.agentById.get(seat.id)?.role : null;
              return (
                <li key={`${seat.type}:${seat.id}`}>
                  {seat.type === "agent" ? (
                    <AgentAvatar agentId={seat.id} name={name} size="sm" state="idle" />
                  ) : (
                    <Avatar kind="person" size="sm" name={name} imageUrl={who.dir.memberById.get(seat.id)?.image} />
                  )}
                  <span className="forum-plist__t">
                    <b>{seat.type === "person" && seat.id === who.me ? t("forum.you", { name }) : name}</b>
                    <small>
                      {[
                        role,
                        seat.type === "person" ? t("forum.table.sits") : null,
                        t("forum.participantsDialog.speaksAt", { n: i + 1 }),
                        seat.id === owner
                          ? t(topic.format === "plan" ? "forum.table.writesPlan" : "forum.table.writes")
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                  </span>
                </li>
              );
            })}
            {topic.userIds
              .filter((id) => !seats.some((x) => x.type === "person" && x.id === id))
              .map((id) => {
                const name = who.personName(id);
                if (!shown(name)) return null;
                return (
                  <li key={id}>
                    <Avatar kind="person" size="sm" name={name} imageUrl={who.dir.memberById.get(id)?.image} />
                    <span className="forum-plist__t">
                      <b>{id === who.me ? t("forum.you", { name }) : name}</b>
                      <small>
                        {spoke(id) ? t("forum.participantsDialog.entered") : t("forum.participantsDialog.notified")}
                      </small>
                    </span>
                  </li>
                );
              })}
            {shown(t("forum.participantsDialog.org")) && (
              <li>
                <span className="forum-plist__org" aria-hidden="true">
                  <Icon name="members" size={16} />
                </span>
                <span className="forum-plist__t">
                  <b>{t("forum.participantsDialog.org")}</b>
                  <small>{t("forum.participantsDialog.orgReads")}</small>
                </span>
              </li>
            )}
          </ul>
        </DialogBody>
      ) : (
        <DialogBody>
          <span className="ac-field__label">{t("forum.form.table")}</span>
          {who.dir.agents.map((ag) => {
            const id = `fp-agent-${ag.id}`;
            const talk = canTalk(ag) || topic.agentIds.includes(ag.id);
            const on = agentIds.includes(ag.id);
            return (
              <label key={ag.id} htmlFor={id} className="scope-row" data-disabled={!talk || undefined}>
                <Checkbox
                  id={id}
                  aria-label={ag.name}
                  disabled={!talk || (on && agentIds.length <= 2)}
                  checked={on}
                  onCheckedChange={(v) => setAgentIds((l) => toggle(l, ag.id, v))}
                />
                <AgentAvatar agentId={ag.id} name={ag.name} size="sm" state="idle" />
                <span className="scope-row__text" aria-hidden="true">
                  <span>{ag.name}</span>
                  <span className="small muted">{talk ? ag.role || `@${ag.handle}` : t("forum.form.noTalk")}</span>
                </span>
              </label>
            );
          })}
          <span className="ac-field__label">{t("forum.form.people")}</span>
          {who.dir.members.map((m) => {
            const id = `fp-person-${m.userId}`;
            const on = userIds.includes(m.userId) || m.userId === who.me;
            const sits = seated.includes(m.userId);
            return (
              <div key={m.userId} className="forum-prow">
                <label htmlFor={id} className="scope-row">
                  <Checkbox
                    id={id}
                    aria-label={m.name}
                    disabled={m.userId === who.me}
                    checked={on}
                    onCheckedChange={(v) => {
                      setUserIds((l) => toggle(l, m.userId, v));
                      if (!v) setSeated((l) => l.filter((x) => x !== m.userId));
                    }}
                  />
                  <Avatar kind="person" size="sm" name={m.name} imageUrl={m.image} />
                  <span className="scope-row__text" aria-hidden="true">
                    <span>{m.userId === who.me ? t("forum.you", { name: m.name }) : m.name}</span>
                  </span>
                </label>
                {on && (
                  <label className="forum-toggle" htmlFor={`${id}-seat`}>
                    <Switch
                      id={`${id}-seat`}
                      checked={sits}
                      onCheckedChange={(v) => {
                        setSeated((l) => toggle(l, m.userId, v));
                        if (v && m.userId !== who.me) setUserIds((l) => toggle(l, m.userId, true));
                      }}
                      aria-label={t("forum.form.seatOther", { name: m.name })}
                    />
                    <span className="small muted">{t("forum.table.sits")}</span>
                  </label>
                )}
              </div>
            );
          })}
        </DialogBody>
      )}
      <DialogFooter note={t("forum.participantsDialog.note")}>
        {editing ? (
          <>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" disabled={!changed || action.isPending} loading={action.isPending} onClick={save}>
              {t("common.save")}
            </Button>
          </>
        ) : (
          !isEnded(topic) && (
            <Button icon="edit" onClick={() => setEditing(true)}>
              {t("forum.participantsDialog.edit")}
            </Button>
          )
        )}
      </DialogFooter>
    </Dialog>
  );
}
