import type { BatchInviteResult, Channel } from "@agenteschat/client";
import {
  useAllInvitations,
  useAuthConfig,
  useChannels,
  useInviteMany,
  useRoles,
  useWorkspaceLimits,
} from "@agenteschat/client";
import { namesText } from "@agenteschat/client/lib/format";
import { sendsEmail } from "@agenteschat/client/lib/join-requests";
import { membersFull } from "@agenteschat/client/lib/limits";
import { can } from "@agenteschat/client/lib/permissions";
import { everyoneOf, isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import { addressesIn, isEmail } from "@agenteschat/client/lib/text";
import { Button, Dialog, DialogBody, DialogFooter, Field, Icon, Textarea } from "@agenteschat/ui";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { OnlyYouNote } from "@/components/AgentAudience";
import { MembersFull } from "@/components/Limits";
import { useOrg } from "@/components/org-context";
import { roleSummary } from "@/components/roles/RolesSection";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { type ChipAddress, ChipNote, ChipRole, EmailChips } from "./EmailChips";
import { InviteLinkPanel } from "./InviteLinkPanel";
import "./invite.css";

/**
 * One dialog invites (ADR 0089 §5), from Members, the workspace menu, ⌘K and a channel's "Adicionar pessoa ou
 * agente": addresses as chips, each with its role; channels they also join and a note in the email, folded; then the
 * workspace's link, for whoever should ask instead.
 */

/** What the dialog opens with: addresses already in it, a channel already chosen (inviting from a channel). */
export interface InviteRequest {
  emails?: string[];
  channelId?: string;
}

const InviteContext = createContext<{ open: (request?: InviteRequest) => void } | null>(null);

/** Null outside the workspace shell (a page rendered alone): nothing there opens the dialog. */
export const useInviteDialog = () => useContext(InviteContext);

/**
 * The workspace's invite dialog, for whoever may invite. Each opening starts over (`n`); it stays mounted while it
 * closes, so the focus goes back to what opened it.
 */
export function InviteDialogProvider({ children }: { children: ReactNode }) {
  const { org } = useOrg();
  const [request, setRequest] = useState<(InviteRequest & { n: number }) | null>(null);
  const [open, setOpen] = useState(false);
  const show = useCallback((next: InviteRequest = {}) => {
    setRequest((current) => ({ ...next, n: (current?.n ?? 0) + 1 }));
    setOpen(true);
  }, []);
  const value = useMemo(() => ({ open: show }), [show]);
  return (
    <InviteContext.Provider value={value}>
      {children}
      {request && can(org, "invite_people") && (
        <InviteDialog key={request.n} request={request} open={open} onClose={() => setOpen(false)} />
      )}
    </InviteContext.Provider>
  );
}

/** An address and the role it joins with (`null`: a member, no role past everyone's). */
interface InviteChip extends ChipAddress {
  roleId: string | null;
}

/** The role picker's value for no role: a member. */
const MEMBER = "member";
/** The longest note in the invitation email (the server's `INVITE_NOTE_MAX`, packages/engine/src/organizations.ts). */
const INVITE_NOTE_MAX = 300;

/** The new addresses in `text`, after the chips already there. */
const chipsFrom = (text: string, known: readonly InviteChip[]): InviteChip[] => {
  const seen = new Set(known.map((c) => c.email));
  return addressesIn(text)
    .filter((a) => !seen.has(a.email))
    .map((a) => ({ ...a, roleId: null }));
};

function InviteDialog({ request, open, onClose }: { request: InviteRequest; open: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const dir = useDirectory(org.id);
  // A server that sends no email invites through the link only.
  const byLink = !sendsEmail(useAuthConfig().data);
  const invitations = useAllInvitations(org.id);
  const orgRoles = useRoles(org.id).data?.roles ?? [];
  const channels = useChannels(org.id).data ?? [];
  const full = membersFull(useWorkspaceLimits(org.id).data) !== null;
  const inviteMany = useInviteMany(org.id);
  const [chips, setChips] = useState<InviteChip[]>(() => chipsFrom((request.emails ?? []).join(", "), []));
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(request.channelId ? [request.channelId] : []));
  const [more, setMore] = useState(false);
  const [note, setNote] = useState("");

  // Who is in already, and who has an invitation waiting: said on their chip and left out of the send.
  const members = new Set(dir.members.map((m) => m.email.toLowerCase()));
  const waiting = new Set(
    (invitations.data ?? []).filter((i) => i.status === "pending").map((i) => i.email.toLowerCase()),
  );
  const stateOf = (c: InviteChip) =>
    !c.valid ? "bad" : members.has(c.email) ? "member" : waiting.has(c.email) ? "invited" : "ok";
  const ready = chips.filter((c) => stateOf(c) === "ok");
  const bad = chips.some((c) => !c.valid);

  // The channels they can be added to: the public ones and the private ones I'm in, #general first (always on).
  const general = channels.find((c) => c.name === "general");
  const offered: Channel[] = [
    ...(general ? [general] : []),
    ...channels.filter((c) => c.id !== general?.id && (c.visibility === "public" || c.isMember)),
  ];
  const extra = offered.filter((c) => c.id !== general?.id && chosen.has(c.id));
  const extraNames = extra.map((c) => `#${c.name}`);
  const summary = [extraNames.join(", "), note.trim() ? t("members.dialog.withNote") : ""].filter(Boolean).join(" · ");

  const everyone = everyoneOf(orgRoles);
  const roleOptions = [
    { value: MEMBER, label: t("roles.member"), description: t("members.chips.memberHint") },
    ...sortRoles(orgRoles.filter((r) => !isEveryone(r) && r.givable)).map((r) => ({
      value: r.id,
      label: r.name,
      description: roleSummary(t, i18n.language, r, everyone),
    })),
  ];

  const send = async () => {
    if (ready.length === 0 || full || inviteMany.isPending) return;
    let results: BatchInviteResult[];
    try {
      results = await inviteMany.mutateAsync({
        invites: ready.map((c) => ({ email: c.email, roleIds: c.roleId ? [c.roleId] : [] })),
        channelIds: extra.map((c) => c.id),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
    } catch {
      // Said by the failed write's toast; the chips stay to send again.
      return;
    }
    const sent = results.filter((r) => r.status === "invited");
    const also = extra.length
      ? t("members.dialog.alsoIn", { channels: namesText(t, extraNames, extraNames.length) })
      : undefined;
    if (sent.length === 1) toast.show(t("members.dialog.sent", { email: sent[0]?.email }), "info", undefined, also);
    else if (sent.length > 1) toast.show(t("members.dialog.sentMany", { count: sent.length }), "info", undefined, also);
    // Only addresses to fix stay: someone in already or invited already was just said, and sending again says it again.
    const fix = new Set<string>();
    for (const r of results) {
      if (r.status === "invited") continue;
      toast.show(t(`members.batch.${r.status}`, { email: r.email }), "error");
      if (r.status === "invalid_email") fix.add(r.email);
    }
    const left = chips.filter((c) => !c.valid || fix.has(c.email));
    setChips(left);
    if (left.length === 0) onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("members.dialog.title", { org: org.name })}
      description={byLink ? t("members.dialog.subLink") : t("members.dialog.sub")}
      closeLabel={t("common.close")}
      width={640}
    >
      <DialogBody className="invite-dialog">
        <MembersFull />
        <OnlyYouNote orgId={org.id} viewerId={me.user.id} />
        {!byLink && (
          <div className="invite-compose">
            <label className="ac-field__label" htmlFor="invite-dialog-emails">
              {t("members.dialog.emails")}
            </label>
            <EmailChips
              id="invite-dialog-emails"
              chips={chips}
              onAdd={(text) => setChips((list) => [...list, ...chipsFrom(text, list)])}
              onRemove={(chip) => setChips((list) => list.filter((c) => c.email !== chip.email))}
              placeholder={t("members.emailsPlaceholder")}
              morePlaceholder={t("members.dialog.moreEmails")}
              describedBy="invite-dialog-help"
              onEnterEmpty={() => void send()}
              aside={(chip) => {
                const state = stateOf(chip);
                if (state === "member") return <ChipNote>{t("members.chips.member", { org: org.name })}</ChipNote>;
                if (state === "invited") return <ChipNote>{t("members.chips.invited")}</ChipNote>;
                return (
                  <ChipRole
                    email={chip.email}
                    value={chip.roleId ?? MEMBER}
                    options={roleOptions}
                    onChange={(v) =>
                      setChips((list) =>
                        list.map((c) => (c.email === chip.email ? { ...c, roleId: v === MEMBER ? null : v } : c)),
                      )
                    }
                  />
                );
              }}
            />
            <span id="invite-dialog-help" className="invite-compose__help" data-bad={bad || undefined}>
              {bad ? t("members.dialog.checkMarked") : t("members.dialog.help")}
            </span>
            <button
              type="button"
              className="invite-more"
              aria-expanded={more}
              aria-controls="invite-dialog-more"
              onClick={() => setMore((m) => !m)}
            >
              <Icon name="chevronRight" size={16} />
              {t("members.dialog.channelsAndNote")}
              {!more && summary && <span className="invite-more__sum">· {summary}</span>}
            </button>
            {more && (
              <div className="invite-more__body" id="invite-dialog-more">
                <span className="invite-more__label" id="invite-dialog-chans">
                  {t("members.dialog.alsoJoin")}
                </span>
                {/* biome-ignore lint/a11y/useSemanticElements: a row of toggles, not a fieldset */}
                <div className="invite-chans" role="group" aria-labelledby="invite-dialog-chans">
                  {offered.map((c) => {
                    const always = c.id === general?.id;
                    const on = always || chosen.has(c.id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        className="invite-chan"
                        aria-pressed={on}
                        disabled={always}
                        title={always ? t("members.dialog.generalAlways", { channel: c.name }) : undefined}
                        onClick={() =>
                          setChosen((prev) => {
                            const next = new Set(prev);
                            if (next.has(c.id)) next.delete(c.id);
                            else next.add(c.id);
                            return next;
                          })
                        }
                      >
                        <Icon name={on ? "check" : "plus"} size={14} />#{c.name}
                      </button>
                    );
                  })}
                </div>
                <Field
                  id="invite-dialog-note"
                  label={
                    <>
                      {t("members.dialog.note")} <span className="invite-optional">{t("members.dialog.optional")}</span>
                    </>
                  }
                >
                  <Textarea
                    rows={2}
                    maxLength={INVITE_NOTE_MAX}
                    value={note}
                    placeholder={t("members.dialog.notePlaceholder", { org: org.name })}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </Field>
              </div>
            )}
          </div>
        )}
        {!byLink && <div className="invite-or">{t("members.dialog.or")}</div>}
        <InviteLinkPanel />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>{byLink ? t("common.close") : t("common.cancel")}</Button>
        {!byLink && (
          <Button
            variant="primary"
            icon="send"
            disabled={ready.length === 0 || full}
            loading={inviteMany.isPending}
            onClick={() => void send()}
          >
            {ready.length ? t("members.dialog.send", { count: ready.length }) : t("members.invite")}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}

/**
 * A channel's "Adicionar pessoa ou agente" search typed with an address nobody here has: whoever may invite gets a
 * row that invites them (by email, so only where the server sends it). Null otherwise.
 */
export function useInviteOffer(query: string): string | null {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const invite = useInviteDialog();
  const emails = sendsEmail(useAuthConfig().data);
  const typed = query.trim().toLowerCase();
  if (!invite || !emails || !can(org, "invite_people") || !isEmail(typed)) return null;
  return dir.members.some((m) => m.email.toLowerCase() === typed) ? null : typed;
}

/** The row `useInviteOffer` offers: the dialog opens with that address and that channel chosen. */
export function InviteOfferRow({ email, channel, onPick }: { email: string; channel: Channel; onPick: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const invite = useInviteDialog();
  return (
    <button
      type="button"
      className="member-row member-row--add"
      onClick={() => {
        onPick();
        invite?.open({ emails: [email], channelId: channel.id });
      }}
    >
      <span className="member-row__plus" aria-hidden="true">
        <Icon name="mail" />
      </span>
      {channel.name === "general"
        ? t("channelMembers.inviteOrg", { email, org: org.name })
        : t("channelMembers.invite", { email, org: org.name, channel: channel.name })}
    </button>
  );
}
