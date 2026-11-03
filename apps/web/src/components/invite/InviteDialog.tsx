import type { Agent, BatchInviteResult, Channel, OrgRole } from "@agenteschat/client";
import {
  channelMembersQuery,
  useAllInvitations,
  useApi,
  useAuthConfig,
  useChannels,
  useInviteMany,
  useJoinRequests,
  useRoles,
  useWorkspaceLimits,
} from "@agenteschat/client";
import { capitalize, joinNames, namesText } from "@agenteschat/client/lib/format";
import { INVITE_NOTE_MAX, sendsEmail } from "@agenteschat/client/lib/join-requests";
import { membersFull } from "@agenteschat/client/lib/limits";
import { can } from "@agenteschat/client/lib/permissions";
import { everyoneOf, isEveryone, roleSummary, sortRoles } from "@agenteschat/client/lib/roles";
import { playSound } from "@agenteschat/client/lib/sounds";
import { addressesIn, isEmail } from "@agenteschat/client/lib/text";
import {
  Avatar,
  AvatarStack,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogFooter,
  Icon,
  LogoMark,
  OptionCard,
  pixelConfetti,
  RoleMark,
  Textarea,
} from "@agenteschat/ui";
import { useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  createContext,
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Trans, useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { OnlyYouNote } from "@/components/AgentAudience";
import { MembersFull } from "@/components/Limits";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { TYPED_VALUES } from "@/i18n";
import { lookOf } from "@/lib/look";
import { useToast } from "@/lib/toast";
import { AddressFace, type ChipAddress, ChipNote, ChipRole, EmailChips } from "./EmailChips";
import { InviteLinkPanel } from "./InviteLinkPanel";
import "@/components/auth.css";
import "./invite.css";

/**
 * One dialog invites (ADR 0090 §5), from Members, the workspace menu, ⌘K and a channel's "Adicionar pessoa ou
 * agente", a step at a time: who (the addresses), their role, the channels they start in, a note with the email as it
 * arrives; then what became of each address. The workspace's first agent asks each step, as on the invitation page.
 * The link is a screen of its own, for whoever should ask instead, and the only one on a server that sends no email.
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

/** The steps an invitation by email goes through, in order. */
const STEPS = ["who", "role", "where", "note"] as const;
type Step = (typeof STEPS)[number];
/** A step, the workspace's link, or what became of each address. */
type Screen = Step | "link" | "sent";

/** The role picker's value for no role: a member. */
const MEMBER = "member";

/** How many agents' faces a channel's row shows at its end. */
const CHANNEL_FACES = 4;

/** When the host answers on the last screen, as its first rows come in (the rows' timing is in invite.css). */
const SENT_HOST_MS = 120;

/** What became of an address: the server's answer, or why it was never sent. */
interface Outcome {
  email: string;
  status: BatchInviteResult["status"];
  roleId: string;
}

/** The new addresses in `text`, after the chips already there. */
const chipsFrom = (text: string, known: readonly ChipAddress[]): ChipAddress[] => {
  const seen = new Set(known.map((c) => c.email));
  return addressesIn(text).filter((a) => !seen.has(a.email));
};

/** "Julia" from julia.martins@acme.com: the address's first word, as the host calls each person. */
const nameOf = (email: string, locale: string) => capitalize(email.split("@")[0]?.split(/[._-]/)[0] || email, locale);

/** The workspace's first agent (the oldest): the one its invitation page receives people with. */
const hostOf = (agents: readonly Agent[]) =>
  [...agents].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0] ?? null;

function InviteDialog({ request, open, onClose }: { request: InviteRequest; open: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const api = useApi();
  const dir = useDirectory(org.id);
  // A server that sends no email invites through the link only.
  const byLink = !sendsEmail(useAuthConfig().data);
  const invitations = useAllInvitations(org.id);
  const orgRoles = useRoles(org.id).data?.roles ?? [];
  const channels = useChannels(org.id).data ?? [];
  const full = membersFull(useWorkspaceLimits(org.id).data) !== null;
  const inviteMany = useInviteMany(org.id);
  const [at, setAt] = useState<Screen>("who");
  const [chips, setChips] = useState<ChipAddress[]>(() => chipsFrom((request.emails ?? []).join(", "), []));
  const [draft, setDraft] = useState("");
  const [role, setRole] = useState(MEMBER);
  const [each, setEach] = useState(false);
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(request.channelId ? [request.channelId] : []));
  const [note, setNote] = useState("");
  const [outcome, setOutcome] = useState<Outcome[]>([]);
  // Each send's own number: the last screen celebrates once per send, never on a re-render.
  const [sends, setSends] = useState(0);
  const screen: Screen = byLink ? "link" : at;
  const index = STEPS.indexOf(screen as Step);
  const emailsField = useRef<HTMLInputElement>(null);
  const noteField = useRef<HTMLTextAreaElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const hostFace = useRef<HTMLSpanElement>(null);
  const first = (email: string) => nameOf(email, i18n.language);
  const host = useMemo(() => hostOf(dir.agents), [dir.agents]);

  // Who is in already, and who has an invitation waiting: said on their chip and left out of the send.
  const members = new Set(dir.members.map((m) => m.email.toLowerCase()));
  const waiting = new Set(
    (invitations.data ?? []).filter((i) => i.status === "pending").map((i) => i.email.toLowerCase()),
  );
  const stateOf = (c: ChipAddress) =>
    !c.valid ? "bad" : members.has(c.email) ? "member" : waiting.has(c.email) ? "invited" : "ok";
  const ready = chips.filter((c) => stateOf(c) === "ok");
  const bad = chips.some((c) => !c.valid);
  const leftOut = chips.some((c) => stateOf(c) === "member" || stateOf(c) === "invited");
  // An address typed and not a chip yet counts: leaving the field for Continuar makes it one.
  const typed = addressesIn(draft).some((a) => stateOf(a) === "ok" && !chips.some((c) => c.email === a.email));

  // The channels they can be added to: the public ones and the private ones I'm in, #general first (always on).
  const general = channels.find((c) => c.name === "general");
  const offered: Channel[] = [
    ...(general ? [general] : []),
    ...channels.filter((c) => c.id !== general?.id && (c.visibility === "public" || c.isMember)),
  ];
  const extra = offered.filter((c) => c.id !== general?.id && chosen.has(c.id));
  const startsIn = [...(general ? [general] : []), ...extra];
  const fromChannel = offered.find((c) => c.id === request.channelId && c.id !== general?.id);
  // Who is in each channel, read when its step shows: how many people, and the agents by face and name.
  const rosters = useQueries({
    queries: offered.map((c) => ({ ...channelMembersQuery(api, org.id, c.id), enabled: open && screen === "where" })),
  });
  const joinRequests = useJoinRequests(org.id, open && screen === "link");

  const everyone = everyoneOf(orgRoles);
  const choices: { value: string; label: string; description: string; role: OrgRole | null }[] = [
    { value: MEMBER, label: t("roles.member"), description: t("members.chips.memberHint"), role: null },
    ...sortRoles(orgRoles.filter((r) => !isEveryone(r) && r.givable)).map((r) => ({
      value: r.id,
      label: r.name,
      description: roleSummary(t, i18n.language, r, everyone),
      role: r,
    })),
  ];
  const roleOptions = choices.map(({ value, label, description }) => ({ value, label, description }));
  // A role no longer there (or no longer this person's to give) reads as Membro.
  const known = (id: string | undefined) => (id && choices.some((c) => c.value === id) ? id : MEMBER);
  const perPerson = each && ready.length > 1;
  const roleFor = (email: string) => known(perPerson ? (roles[email] ?? role) : role);
  const roleName = (id: string) => choices.find((c) => c.value === id)?.label ?? t("roles.member");

  const next = () => {
    if (screen === "who") {
      // What's typed and not a chip yet goes in first, as leaving the field would have put it.
      const list = draft.trim() ? [...chips, ...chipsFrom(draft, chips)] : chips;
      if (list !== chips) {
        setChips(list);
        setDraft("");
      }
      if (full || !list.some((c) => stateOf(c) === "ok")) return;
    }
    const following = STEPS[index + 1];
    if (following) setAt(following);
  };
  const back = () => {
    const before = STEPS[index - 1];
    if (before) setAt(before);
  };
  const perPersonOn = () => {
    setRoles((prev) => {
      const out = { ...prev };
      for (const c of ready) out[c.email] ??= role;
      return out;
    });
    setEach(true);
  };
  // Inviting more starts over, in the same channels.
  const again = () => {
    setChips([]);
    setDraft("");
    setRole(MEMBER);
    setEach(false);
    setRoles({});
    setNote("");
    setOutcome([]);
    setAt("who");
  };

  const send = async () => {
    if (ready.length === 0 || full || inviteMany.isPending) return;
    let results: BatchInviteResult[];
    try {
      results = await inviteMany.mutateAsync({
        invites: ready.map((c) => {
          const id = roleFor(c.email);
          return { email: c.email, roleIds: id === MEMBER ? [] : [id] };
        }),
        channelIds: extra.map((c) => c.id),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
    } catch {
      // Said by the failed write's toast; everything stays to send again.
      return;
    }
    // An address the server reads as none goes back to the first step, marked, to fix or take out; the rest went.
    const fix = new Set(results.filter((r) => r.status === "invalid_email").map((r) => r.email));
    if (fix.size > 0) {
      const sent = results.filter((r) => r.status === "invited");
      if (sent.length === 1) toast.show(t("members.dialog.sent", { email: sent[0]?.email }));
      else if (sent.length > 1) toast.show(t("members.dialog.sentMany", { count: sent.length }));
      for (const email of fix) toast.show(t("members.batch.invalid_email", { email }), "error");
      setChips((list) =>
        list.filter((c) => !c.valid || fix.has(c.email)).map((c) => (fix.has(c.email) ? { ...c, valid: false } : c)),
      );
      setAt("who");
      return;
    }
    // Every address, each with the server's answer, or why it never went (in already, invited already, no address).
    const said = new Map(results.map((r) => [r.email, r.status]));
    const never = { bad: "invalid_email", member: "already_member", invited: "already_invited" } as const;
    setOutcome(
      chips.flatMap((c) => {
        const state = stateOf(c);
        const status = said.get(c.email) ?? (state === "ok" ? undefined : never[state]);
        return status ? [{ email: c.email, status, roleId: roleFor(c.email) }] : [];
      }),
    );
    setSends((n) => n + 1);
    setAt("sent");
  };

  // A new step starts where it's answered: the field on the first and the note's; elsewhere the button that goes on,
  // when the control that had the focus went away with the step before.
  const shown = useRef(screen);
  useEffect(() => {
    if (shown.current === screen) return;
    shown.current = screen;
    if (screen === "who") emailsField.current?.focus();
    else if (screen === "note") noteField.current?.focus();
    else {
      const box = primary.current?.closest('[role="dialog"]');
      const now = document.activeElement;
      if (!now || now === document.body || now === box || !box?.contains(now)) primary.current?.focus();
    }
  }, [screen]);

  // The last screen, once per send that sent someone: the host jumps in a burst of pixels and the "approved" sound
  // plays (the person's sound choice applies). The rows, the bubble, the jump and the checks move in CSS; with reduced
  // motion nothing moves and no confetti falls (`pixelConfetti` draws nothing), and the sound still plays.
  const celebrated = useRef(0);
  useEffect(() => {
    if (screen !== "sent" || sends === 0 || celebrated.current === sends) return;
    if (!outcome.some((o) => o.status === "invited")) return;
    const timer = setTimeout(() => {
      celebrated.current = sends;
      playSound("approved");
      const face = hostFace.current?.getBoundingClientRect();
      if (face) pixelConfetti({ x: face.left + face.width / 2, y: face.top + face.height / 2 });
    }, SENT_HOST_MS);
    return () => clearTimeout(timer);
  }, [screen, sends, outcome]);

  const sentOk = outcome.filter((o) => o.status === "invited");
  // Someone was sent: the host is happy, and jumps.
  const party = screen === "sent" && sentOk.length > 0;
  const channelsSaid = joinNames(
    startsIn.map((c) => `#${c.name}`),
    t,
  );
  // The host's question on each screen, its answer on the last one.
  const askOf = (): { title: string; lead: string } => {
    const one = ready.length === 1 ? first(ready[0]?.email ?? "") : null;
    if (screen === "who") return { title: t("members.dialog.who.title"), lead: t("members.dialog.who.lead") };
    if (screen === "role")
      return {
        title: one ? t("members.dialog.role.titleOne", { name: one }) : t("members.dialog.role.titleMany"),
        lead: t("members.dialog.role.lead"),
      };
    if (screen === "where")
      return {
        title: one ? t("members.dialog.where.titleOne", { name: one }) : t("members.dialog.where.titleMany"),
        lead: t("members.dialog.where.lead", { channel: general?.name ?? "general" }),
      };
    if (screen === "note")
      return { title: t("members.dialog.noteStep.title"), lead: t("members.dialog.noteStep.lead") };
    if (screen === "link")
      return { title: t("members.dialog.linkStep.title", { org: org.name }), lead: t("members.dialog.linkStep.lead") };
    if (sentOk.length === 0) return { title: t("members.dialog.done.none"), lead: t("members.dialog.done.noneLead") };
    const names = namesText(
      t,
      sentOk.map((o) => first(o.email)),
      3,
    );
    return {
      title: t("members.dialog.done.title", { names }),
      lead:
        sentOk.length === 1
          ? t("members.dialog.done.leadOne", { name: first(sentOk[0]?.email ?? ""), channels: channelsSaid })
          : t("members.dialog.done.leadMany", { channels: channelsSaid }),
    };
  };
  const ask = askOf();

  const toggleChannel = (id: string, on: boolean) =>
    setChosen((prev) => {
      const out = new Set(prev);
      if (on) out.add(id);
      else out.delete(id);
      return out;
    });

  let answer: ReactNode;
  if (screen === "who")
    answer = (
      <>
        <MembersFull />
        <OnlyYouNote orgId={org.id} viewerId={me.user.id} />
        <label className="ac-visually-hidden" htmlFor="invite-dialog-emails">
          {t("members.dialog.emails")}
        </label>
        <EmailChips
          id="invite-dialog-emails"
          inputRef={emailsField}
          chips={chips}
          draft={draft}
          onDraftChange={setDraft}
          onAdd={(text) => setChips((list) => [...list, ...chipsFrom(text, list)])}
          onRemove={(chip) => setChips((list) => list.filter((c) => c.email !== chip.email))}
          placeholder={t("members.emailsPlaceholder")}
          morePlaceholder={t("members.dialog.moreEmails")}
          describedBy="invite-dialog-help"
          onEnterEmpty={next}
          soft={(chip) => stateOf(chip) !== "ok"}
          aside={(chip) => {
            const state = stateOf(chip);
            if (state === "member") return <ChipNote>{t("members.chips.member", { org: org.name })}</ChipNote>;
            if (state === "invited") return <ChipNote>{t("members.chips.invited")}</ChipNote>;
            return null;
          }}
        />
        <p id="invite-dialog-help" className="invite-help" data-bad={bad || undefined}>
          {bad
            ? t("members.dialog.checkMarked")
            : leftOut
              ? t("members.dialog.leftOut")
              : t("members.dialog.pasteHelp")}
        </p>
        <div className="invite-orlink">
          <span className="invite-tile" aria-hidden="true">
            <Icon name="link" size={18} />
          </span>
          <span className="invite-orlink__text">
            <b>{t("members.dialog.orLink.title")}</b>
            <span>{t("members.dialog.orLink.text")}</span>
          </span>
          <Button size="sm" onClick={() => setAt("link")}>
            {t("members.dialog.orLink.open")}
          </Button>
        </div>
      </>
    );
  else if (screen === "role")
    answer = perPerson ? (
      <>
        <ul className="invite-people ac-list">
          {ready.map((c) => (
            <li key={c.email} className="invite-person">
              <AddressFace email={c.email} />
              <span className="invite-person__email">{c.email}</span>
              <ChipRole
                email={c.email}
                value={roleFor(c.email)}
                options={roleOptions}
                onChange={(v) => setRoles((prev) => ({ ...prev, [c.email]: v }))}
              />
            </li>
          ))}
        </ul>
        <button type="button" className="invite-each" aria-expanded="true" onClick={() => setEach(false)}>
          <Icon name="chevronRight" size={16} />
          {t("members.dialog.role.same")}
        </button>
      </>
    ) : (
      <>
        {/* biome-ignore lint/a11y/useSemanticElements: option cards named by the host's question, not a fieldset */}
        <div className="invite-roles" role="group" aria-labelledby="invite-dialog-ask">
          {choices.map((c) => (
            <OptionCard key={c.value} pressed={known(role) === c.value} onClick={() => setRole(c.value)}>
              <RoleSeal role={c.role ?? everyone ?? null} />
              <span className="ac-option__text">
                <span className="ac-option__title">{c.label}</span>
                <span className="ac-option__desc">{c.description}</span>
              </span>
            </OptionCard>
          ))}
        </div>
        {ready.length > 1 && (
          <button type="button" className="invite-each" aria-expanded="false" onClick={perPersonOn}>
            <Icon name="chevronRight" size={16} />
            {t("members.dialog.role.each")}
          </button>
        )}
      </>
    );
  else if (screen === "where")
    answer = (
      <>
        {/* biome-ignore lint/a11y/useSemanticElements: a list of checkboxes, not a fieldset */}
        <div className="invite-chans ac-list" role="group" aria-label={t("members.dialog.where.label")}>
          {offered.map((c, i) => {
            const always = c.id === general?.id;
            const roster = rosters[i]?.data;
            const agents = (roster ?? [])
              .filter((m) => m.type === "agent")
              .flatMap((m) => dir.agentById.get(m.id) ?? []);
            const people = (roster ?? []).filter((m) => m.type === "person").length;
            const named = agents.length
              ? namesText(
                  t,
                  agents.map((a) => a.name),
                  2,
                )
              : "";
            const sub = always
              ? t("members.dialog.where.everyone")
              : c.visibility === "private"
                ? t("members.dialog.where.private")
                : roster
                  ? [t("members.dialog.where.people", { count: people }), named].filter(Boolean).join(" · ")
                  : "";
            const id = `invite-chan-${c.id}`;
            return (
              <label key={c.id} htmlFor={id} className="invite-chan" data-fixed={always || undefined}>
                <Checkbox
                  id={id}
                  checked={always || chosen.has(c.id)}
                  disabled={always}
                  aria-label={`#${c.name}`}
                  aria-describedby={sub ? `${id}-sub` : undefined}
                  onCheckedChange={(on) => toggleChannel(c.id, on)}
                />
                <span className="invite-chan__text">
                  <span className="invite-chan__name">
                    {c.visibility === "private" && <Icon name="lock" size={14} />}#{c.name}
                  </span>
                  {sub && (
                    <span className="invite-chan__sub" id={`${id}-sub`}>
                      {sub}
                    </span>
                  )}
                </span>
                {agents.length > 0 && (
                  <span className="invite-chan__faces" aria-hidden="true">
                    {agents.slice(0, CHANNEL_FACES).map((a) => (
                      <AgentAvatar key={a.id} name={a.name} appearance={lookOf(a)} size="xs" />
                    ))}
                  </span>
                )}
              </label>
            );
          })}
        </div>
        {fromChannel && (
          <p className="invite-help invite-help--note">
            {t("members.dialog.where.fromChannel", { channel: fromChannel.name })}
          </p>
        )}
      </>
    );
  else if (screen === "note")
    answer = (
      <>
        <Textarea
          ref={noteField}
          className="invite-note"
          rows={3}
          maxLength={INVITE_NOTE_MAX}
          value={note}
          aria-label={t("members.dialog.note")}
          placeholder={t("members.dialog.notePlaceholder", { org: org.name })}
          onChange={(e) => setNote(e.target.value)}
        />
        <MailPreview to={ready.map((c) => c.email)} names={ready.map((c) => first(c.email))} note={note} />
      </>
    );
  else if (screen === "link")
    answer = (
      <>
        {byLink && (
          <>
            <MembersFull />
            <OnlyYouNote orgId={org.id} viewerId={me.user.id} />
          </>
        )}
        <InviteLinkPanel />
        <ol className="invite-how">
          {(["how1", "how2", "how3"] as const).map((k, i) => (
            <li key={k}>
              <span className="invite-how__n" aria-hidden="true">
                {i + 1}
              </span>
              {t(`members.dialog.linkStep.${k}`)}
            </li>
          ))}
        </ol>
        <LinkRequests requests={joinRequests.data ?? []} onOpen={onClose} />
      </>
    );
  else {
    // The ones that went come in first, then the rest, each after the one before (`--i`, in invite.css).
    const order = [...sentOk, ...outcome.filter((o) => o.status !== "invited")].map((o) => o.email);
    answer = (
      <ul className="invite-people ac-list">
        {outcome.map((o) => (
          <li
            key={o.email}
            className="invite-person"
            data-ok={o.status === "invited" || undefined}
            style={{ "--i": order.indexOf(o.email) } as CSSProperties}
          >
            <AddressFace email={o.email} />
            <span className="invite-person__email">
              {o.email}
              {o.status === "invited" && <span className="invite-person__role"> · {roleName(o.roleId)}</span>}
            </span>
            {o.status === "invited" ? (
              <span className="invite-state">
                <Icon name="check" size={14} />
                {t("members.dialog.result.invited")}
              </span>
            ) : (
              <span className="invite-state" data-skip="true">
                {t(`members.dialog.result.${o.status}`, { org: org.name })}
              </span>
            )}
          </li>
        ))}
      </ul>
    );
  }

  let footer: ReactNode;
  if (screen === "sent")
    footer = (
      <>
        <Button key="lead" variant="ghost" icon="plus" onClick={again}>
          {t("members.dialog.again")}
        </Button>
        <span className="invite-foot__gap" />
        <Button key="primary" ref={primary} variant="primary" onClick={onClose}>
          {t("members.dialog.finish")}
        </Button>
      </>
    );
  else if (screen === "link")
    footer = (
      <>
        {!byLink && (
          <Button key="lead" variant="ghost" icon="chevronLeft" onClick={() => setAt("who")}>
            {t("members.dialog.linkStep.byEmail")}
          </Button>
        )}
        <span className="invite-foot__gap" />
        <Button key="primary" ref={primary} onClick={onClose}>
          {t("common.close")}
        </Button>
      </>
    );
  else
    footer = (
      <>
        {index > 0 ? (
          <Button key="lead" variant="ghost" icon="chevronLeft" onClick={back}>
            {t("common.back")}
          </Button>
        ) : (
          <Button key="lead" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
        )}
        <span className="invite-foot__gap" />
        {screen === "note" ? (
          <Button
            key="primary"
            ref={primary}
            variant="primary"
            icon="send"
            disabled={ready.length === 0 || full}
            loading={inviteMany.isPending}
            onClick={() => void send()}
          >
            {t("members.dialog.send", { count: ready.length })}
          </Button>
        ) : (
          <Button
            key="primary"
            ref={primary}
            variant="primary"
            kbd={["↵"]}
            disabled={screen === "who" && (full || (ready.length === 0 && !typed))}
            onClick={next}
          >
            {ready.length > 1 ? t("members.dialog.continueWith", { count: ready.length }) : t("common.continue")}
          </Button>
        )}
      </>
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("members.dialog.title", { org: org.name })}
      subtitle={
        index >= 0
          ? t("members.dialog.stepOf", {
              n: index + 1,
              total: STEPS.length,
              step: t(`members.dialog.steps.${screen as Step}`),
            })
          : undefined
      }
      closeLabel={t("common.close")}
      width={600}
      initialFocus={screen === "who" ? emailsField : undefined}
    >
      {index >= 0 && (
        <div className="ac-steps invite-steps" aria-hidden="true">
          {STEPS.map((s, i) => (
            <span key={s} className="ac-steps__bar" data-done={i <= index} />
          ))}
        </div>
      )}
      <DialogBody className="invite-dialog">
        <div
          className="invite-screen"
          key={screen}
          data-sent={screen === "sent" || undefined}
          data-party={party || undefined}
        >
          <HostAsk host={host} title={ask.title} lead={ask.lead} happy={party} face={hostFace} />
          <div className="auth__step invite-answer">{answer}</div>
        </div>
      </DialogBody>
      <DialogFooter>{footer}</DialogFooter>
    </Dialog>
  );
}

/**
 * The host, the workspace's first agent as it looks there (the product's own face with none), asking in its bubble
 * as on the invitation page (`.auth__ask`, components/auth.css); happy once the invitations went.
 */
function HostAsk({
  host,
  title,
  lead,
  happy,
  face,
}: {
  host: Agent | null;
  title: string;
  lead: string;
  happy: boolean;
  face: RefObject<HTMLSpanElement | null>;
}) {
  const expression = happy ? "happy" : undefined;
  return (
    <div className="auth__ask invite-host">
      <span className="invite-host__face" ref={face}>
        {host ? (
          <AgentAvatar name={host.name} appearance={lookOf(host)} expression={expression} />
        ) : (
          <AgentAvatar name="agentes.chat" expression={expression} />
        )}
      </span>
      <div className="auth__bubble" aria-live="polite">
        <h2 className="auth__title" id="invite-dialog-ask">
          {title}
        </h2>
        <p className="auth__lead">{lead}</p>
      </div>
    </div>
  );
}

/** A role's mark on its card (ADR 0085): Membro takes `everyone`'s, the base every person has. */
function RoleSeal({ role }: { role: OrgRole | null }) {
  if (role) return <RoleMark color={role.color} icon={role.icon} size={36} />;
  return (
    <span className="invite-tile" aria-hidden="true">
      <Icon name="person" size={18} />
    </span>
  );
}

/**
 * The invitation email as it arrives, in the words the server sends it in (the `invitation` template,
 * packages/engine/src/email.ts): who sent it and to whom, the subject, the headline, who invites to which workspace,
 * the note, the button and how long it works.
 */
function MailPreview({ to, names, note }: { to: readonly string[]; names: readonly string[]; note: string }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const [head = ""] = to;
  const toSaid = to.length > 1 ? t("members.dialog.mail.toMany", { email: head, count: to.length - 1 }) : head;
  const said = note.trim();
  return (
    <figure className="invite-mail-fig">
      <figcaption className="invite-mail-label">
        <Icon name="mail" size={16} />
        {t("members.dialog.mailFor", { names: namesText(t, [...names], 2) })}
      </figcaption>
      <div className="invite-mail">
        <div className="invite-mail__from">
          <LogoMark size={28} />
          <span className="invite-mail__who">
            <b>{t("members.dialog.mail.subject")}</b>
            <span>{t("members.dialog.mail.from", { to: toSaid })}</span>
          </span>
        </div>
        <h3 className="invite-mail__title">{t("members.dialog.mail.headline")}</h3>
        <p>
          <Trans
            i18nKey="members.dialog.mail.body"
            values={{ name: me.user.name, email: me.user.email, org: org.name }}
            components={{ b: <b /> }}
            {...TYPED_VALUES}
          />
        </p>
        {said && (
          <p className="invite-mail__note">
            <Trans
              i18nKey="members.dialog.mail.noteFrom"
              values={{ name: me.user.name, note: said }}
              components={{ b: <b /> }}
              {...TYPED_VALUES}
            />
          </p>
        )}
        <p className="invite-mail__what">{t("members.dialog.mail.what")}</p>
        <span className="invite-mail__btn">{t("members.dialog.mail.button")}</span>
        <span className="invite-mail__foot">{t("members.dialog.mail.small")}</span>
      </div>
    </figure>
  );
}

/** The requests to join waiting (ADR 0068): who asked, and the way to Members, where each is answered. */
function LinkRequests({ requests, onOpen }: { requests: readonly { id: string; name: string }[]; onOpen: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  if (requests.length === 0) return null;
  return (
    <div className="invite-waiting">
      <AvatarStack aria-hidden="true">
        {requests.slice(0, 3).map((r) => (
          <Avatar key={r.id} name={r.name} size="sm" />
        ))}
      </AvatarStack>
      <span className="invite-waiting__text">
        <b>{t("members.dialog.linkStep.waiting", { count: requests.length })}</b>
        <span>
          {namesText(
            t,
            requests.map((r) => r.name),
            2,
          )}
        </span>
      </span>
      <Button size="sm" asChild>
        <Link to="/org/$orgId/settings/$section" params={{ orgId: org.id, section: "members" }} onClick={onOpen}>
          {t("members.dialog.linkStep.seeRequests")}
        </Link>
      </Button>
    </div>
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
