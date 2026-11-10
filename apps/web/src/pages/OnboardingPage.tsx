import { ApiError, keys, meQuery, useAuthConfig, type WorkspaceMode } from "@agenteschat/client";
import { accountOutOfReach } from "@agenteschat/client/lib/deletion";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { settingUp } from "@agenteschat/client/lib/guards";
import { sendsEmail } from "@agenteschat/client/lib/join-requests";
import { finishOnboarding, RIGHT_HAND_DEFAULT } from "@agenteschat/client/lib/right-hand";
import { browserTimezone, timezoneName } from "@agenteschat/client/lib/routines";
import { Button, Field, Icon, Input, Locked, Logo, OptionList, setGaze } from "@agenteschat/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useAuth } from "@/auth/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { BillingLinkButton } from "@/components/BillingLinkButton";
import { DeleteAccountEntry } from "@/components/DeleteAccount";
import { DeleteWorkspaceDialog } from "@/components/DeleteWorkspace";
import { ImageCropDialog, OrgMark } from "@/components/ProfilePhoto";
import { PurposeScene } from "@/components/PurposeScene";
import { BootSplash } from "@/components/Sky";
import { ZonePicker } from "@/components/ZoneSelect";
import { ARRIVAL_PARAM } from "@/lib/arrival";
import { sendNewLink } from "@/lib/email-confirmation";
import { useOpenParam } from "@/lib/open-param";
import { returnPlace } from "@/lib/return-to";
import { STORAGE_KEYS, sessionStore, storage } from "@/lib/storage";
import { useToast } from "@/lib/toast";
import "./onboarding.css";

/**
 * The onboarding, asked by its right hand: what the workspace is for (ADR 0159), then, for a company or team, its name
 * (with its logo and time zone); "For me" makes a personal workspace at once, named in the person's language with the
 * browser's time zone. Then the right hand's DM, where the rest of the setup is cards (ADR 0137). A workspace still
 * being set up from an older onboarding, whatever step it was on, is finished and opened there.
 */
export function OnboardingPage() {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const auth = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();

  // Who it is for (ADR 0159), then, for a team, its name: one question at a time.
  const [purpose, setPurpose] = useState<WorkspaceMode | null>(null);
  const [step, setStep] = useState<"purpose" | "name">("purpose");
  // On the first question the chosen answer's agents look at the pointer (`PurposeScene`, its `data-gaze`).
  useEffect(() => {
    if (step !== "purpose") return;
    const look = (e: PointerEvent) => setGaze({ x: e.clientX, y: e.clientY });
    window.addEventListener("pointermove", look);
    return () => {
      window.removeEventListener("pointermove", look);
      setGaze(null);
    };
  }, [step]);
  const personal = purpose === "personal";
  const [org, setOrg] = useState("");
  const [zone, setZone] = useState(() => browserTimezone() ?? "UTC");
  const [zoneOpen, setZoneOpen] = useState(false);
  const [logo, setLogo] = useState<{ imageBase64: string; contentType: string } | null>(null);
  const [logoDirty, setLogoDirty] = useState(false);
  const [logoOpen, setLogoOpen] = useState(false);
  // Made here, or the one being set up when this page opened to delete it.
  const [created, setCreated] = useState<{ orgId: string } | null>(null);
  // "Apagar este workspace": its dialog kept in the address (`?delete=1`, which the phone's onboarding opens).
  const [deleting, setDeleting] = useOpenParam("delete");

  const me = useQuery({ ...meQuery(api), refetchOnWindowFocus: "always" });
  const authConfig = useAuthConfig().data;
  // On agentes.chat Cloud, while sign-up is by invitation, only accounts early access allowed make workspaces (ADR 0078).
  const inviteOnly = me.data?.user.canCreateWorkspace === false && created === null;
  const emails = sendsEmail(authConfig);
  const email = me.data?.user.email ?? "";
  // Their face in the first question's drawings: the account's photo (Google's), else their initials.
  const you = { name: me.data?.user.name || email, image: me.data?.user.image ?? null };
  // The address this tab's sign-up was emailed a link to confirm: the step says where it went. Read once and
  // forgotten once confirmed or set up, so a later onboarding (another workspace) says nothing of it.
  const [sentTo] = useState(() => sessionStore.get(STORAGE_KEYS.confirmationSent));
  const verified = me.data?.user.emailVerified === true;
  const confirmationSent = email !== "" && sentTo === email && !verified;
  // Early access counts only for a confirmed address (ADR 0078 §4): held here unconfirmed, a new link is the way on.
  const confirmFirst = inviteOnly && emails && email !== "" && !verified && !confirmationSent;
  useEffect(() => {
    if (verified) sessionStore.remove(STORAGE_KEYS.confirmationSent);
  }, [verified]);
  const resend = useMutation({ mutationFn: () => sendNewLink({ auth, t, show: toast.show }, email) });

  // Someone who already has a workspace can give up on a new one: back to the one they were in (or any other).
  const others = (me.data?.organizations ?? []).filter((o) => o.id !== created?.orgId && !settingUp(o));
  const leaveTo = others.find((o) => o.id === storage.get(STORAGE_KEYS.lastOrg)) ?? others[0];

  const openWorkspace = async (orgId: string) => {
    const at = await finishOnboarding(api, orgId);
    sessionStore.remove(STORAGE_KEYS.confirmationSent);
    await qc.invalidateQueries({ queryKey: keys.me });
    // The workspace opens on its arrival (ADR 0160): the beta notice, then Connect an AI.
    const search = { [ARRIVAL_PARAM]: 1 } as never;
    if (at.agentId)
      await navigate({ to: "/org/$orgId/dm/agent/$agentId", params: { orgId, agentId: at.agentId }, search });
    else await navigate({ to: "/org/$orgId", params: { orgId }, search });
  };

  const save = useMutation({
    // Owning a workspace that waits for its first plan is said in place, with the way to that plan.
    meta: { silent: true },
    onError: (e) => {
      if (errorCode(e) !== "org.create_unpaid") toast.show(errorText(t, e), "error");
    },
    mutationFn: async () => {
      let target = created;
      if (!target) {
        // "For me": no name to ask, the word for it in the person's language (renamed in Settings like any other).
        const res = await api.orgs.create(
          personal ? { name: t("onboarding.personal.name"), mode: "personal" } : { name: org.trim() },
        );
        target = { orgId: res.organization.id };
        setCreated(target);
        await api.orgs.updateSettings(target.orgId, { timezone: zone });
        // The person's own zone, detected here: agents read the local time from it (the language is `useServerLocale`'s).
        const mine = browserTimezone();
        if (mine) await api.orgs.updateMe(target.orgId, { timezone: mine }).catch(() => undefined);
      } else {
        // Made here already (a step after failed): the answer as it is now, the mode included.
        await api.orgs.updateSettings(
          target.orgId,
          personal ? { timezone: zone, mode: "personal" } : { name: org.trim(), timezone: zone, mode: "team" },
        );
      }
      // The logo needs the workspace: picked before it existed, sent now (a team's only: "For me" asks none).
      if (logoDirty && !personal) {
        if (logo) await api.orgs.setLogo(target.orgId, logo);
        else await api.orgs.removeLogo(target.orgId);
        setLogoDirty(false);
      }
      await openWorkspace(target.orgId);
    },
  });

  // One being set up already (another tab, an older onboarding cut short at any step): it opens, never a second
  // workspace; asked to delete it, its dialog opens here instead.
  const unfinished = created ? undefined : me.data?.organizations.find(settingUp);
  const opening = useRef<string | null>(null);
  useEffect(() => {
    if (!unfinished || opening.current === unfinished.id) return;
    opening.current = unfinished.id;
    if (deleting !== null) setCreated({ orgId: unfinished.id });
    else void openWorkspace(unfinished.id).catch((e) => toast.show(errorText(t, e), "error"));
  });

  const refused = save.error;
  const unpaidElsewhere =
    refused instanceof ApiError && refused.code === "org.create_unpaid" && typeof refused.params?.orgId === "string"
      ? refused.params.orgId
      : null;
  const blocked = (step === "purpose" ? !purpose : !org.trim()) || inviteOnly;
  const busy = save.isPending;
  // Continue: "For me" makes the workspace now; a company or team names it first.
  const next = () => {
    if (step === "purpose" && !personal) setStep("name");
    else save.mutate();
  };
  const mine = me.data?.organizations.find((o) => o.id === created?.orgId);
  const savedLogo = logoDirty ? null : mine?.logo;

  if (unfinished && deleting === null) return <BootSplash />;

  return (
    <div className="onb">
      <aside className="onb__rail">
        <span className="onb__brand">
          <Logo size={22} />
        </span>
        {/* Until it's finished this is the only screen: the way out of the workspace is here, and of the account for
            someone with no other workspace that opens. */}
        {created && (
          <button type="button" className="onb__signout" onClick={() => setDeleting(1)}>
            {t("onboarding.deleteLink")}
          </button>
        )}
        <button
          type="button"
          className="onb__signout"
          onClick={async () => {
            await auth.signOut();
            qc.clear();
            await navigate({ to: "/login" });
          }}
        >
          {t("auth.signOut")}
        </button>
        {me.data && accountOutOfReach(me.data.organizations) && (
          <div className="onb__account">
            <span className="onb__account-title">{t("deleteAccount.whole")}</span>
            <DeleteAccountEntry
              trigger={(openIt) => (
                <button type="button" className="onb__signout" onClick={openIt}>
                  {t("deleteAccount.menu")}
                </button>
              )}
            />
          </div>
        )}
        {created && (
          <DeleteWorkspaceDialog
            org={{ id: created.orgId, name: mine?.name ?? org.trim() }}
            open={deleting !== null}
            onClose={() => setDeleting(null)}
            onDeleted={() => void navigate({ to: "/org/$orgId", params: { orgId: created.orgId } })}
          />
        )}
      </aside>

      <main
        className="onb__main"
        onKeyDown={(e) => {
          // Enter continues (the big button shows ↵), except where Enter means something else.
          const el = e.target as HTMLElement;
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          // On an answer of the first question too: a radio takes no Enter of its own (it stops it, though).
          const answer = el.matches("[role='radio']");
          if (!answer && e.defaultPrevented) return;
          if (!answer && el.closest("button, a, [role='dialog'], [role='listbox'], [role='combobox']")) return;
          if (blocked || busy) return;
          e.preventDefault();
          next();
        }}
      >
        <div className="onb__body">
          {step === "name" ? (
            <button type="button" className="onb__back" onClick={() => setStep("purpose")} disabled={busy}>
              <Icon name="chevronLeft" size={16} />
              {t("onboarding.back")}
            </button>
          ) : (
            leaveTo && (
              <button
                type="button"
                className="onb__back"
                onClick={() => void navigate({ href: returnPlace(leaveTo.id) })}
                disabled={busy}
              >
                <Icon name="chevronLeft" size={16} />
                {t("onboarding.leave", { name: leaveTo.name })}
              </button>
            )
          )}

          {/* Its right hand asks: the face the person meets again in its DM. */}
          <header className="onb__ask">
            <span className="onb__host" data-fresh="">
              <AgentAvatar
                name={RIGHT_HAND_DEFAULT.name}
                appearance={RIGHT_HAND_DEFAULT.appearance}
                size="lg"
                expression="happy"
              />
              <span className="onb__host-name">{RIGHT_HAND_DEFAULT.name}</span>
            </span>
            {step === "purpose" ? (
              <div className="onb__bubble" key="purpose">
                <h1 className="onb__title">{t("onboarding.purpose.title")}</h1>
                <p className="onb__lead">{t("onboarding.purpose.lead")}</p>
              </div>
            ) : (
              <div className="onb__bubble" key="name">
                <h1 className="onb__title">{t("onboarding.workspace.title")}</h1>
                <p className="onb__lead">{t("onboarding.workspace.lead")}</p>
              </div>
            )}
          </header>

          <Locked when={busy}>
            {step === "purpose" ? (
              <div className="onb__answer" key="purpose">
                <OptionList<WorkspaceMode | "">
                  aria-label={t("onboarding.purpose.title")}
                  layout="cards"
                  className="onb-purpose"
                  value={purpose ?? ""}
                  onValueChange={(v) => setPurpose(v || null)}
                  options={PURPOSES.map((mode) => ({
                    value: mode,
                    leading: <PurposeScene kind={mode} chosen={purpose === mode} you={you} />,
                    title: t(`onboarding.purpose.${mode}`),
                    description: (
                      <>
                        <span>{t(`onboarding.purpose.${mode}Text`)}</span>
                        <span className="onb-purpose__examples">{t(`onboarding.purpose.${mode}Examples`)}</span>
                      </>
                    ),
                  }))}
                />
                {unpaidElsewhere && <UnpaidNote orgId={unpaidElsewhere} billing={Boolean(authConfig?.billingUrl)} />}
              </div>
            ) : (
              <div className="onb__answer" key="name">
                <div className="onb__ws">
                  <button
                    type="button"
                    className="onb__logo"
                    aria-label={logo ? t("onboarding.workspace.logoChange") : t("onboarding.workspace.logoPick")}
                    title={t("onboarding.workspace.logoHelp")}
                    onClick={() => setLogoOpen(true)}
                  >
                    {logo ? (
                      <OrgMark logo={`data:${logo.contentType};base64,${logo.imageBase64}`} size={56} />
                    ) : savedLogo ? (
                      <OrgMark logo={savedLogo} size={56} />
                    ) : org.trim() ? (
                      <span className="onb__logo-letter">{org.trim().charAt(0).toUpperCase()}</span>
                    ) : (
                      <Icon name="upload" />
                    )}
                  </button>
                  <Input
                    className="onb__big"
                    aria-label={t("onboarding.workspace.name")}
                    value={org}
                    onChange={(e) => setOrg(e.target.value)}
                    placeholder={t("onboarding.workspace.namePlaceholder")}
                    spellCheck={false}
                    autoFocus
                  />
                </div>
                {zoneOpen ? (
                  <Field
                    label={t("onboarding.workspace.timezone")}
                    id="org-zone"
                    hint={{
                      name: t("common.about", { label: t("onboarding.workspace.timezone") }),
                      text: t("onboarding.workspace.timezoneHelp"),
                    }}
                  >
                    <ZonePicker
                      id="org-zone"
                      value={zone}
                      onChange={setZone}
                      suggested={[browserTimezone() ?? "", "UTC"].filter(Boolean)}
                    />
                  </Field>
                ) : (
                  <p className="onb__help">
                    {t("onboarding.workspace.zone", { zone: timezoneName(zone, i18n.language) })} ·{" "}
                    <button type="button" className="ac-link onb__link" onClick={() => setZoneOpen(true)}>
                      {t("onboarding.workspace.zoneChange")}
                    </button>
                  </p>
                )}
                <ImageCropDialog
                  open={logoOpen}
                  onClose={() => setLogoOpen(false)}
                  title={t("orgLogo.title")}
                  help={t("orgLogo.help")}
                  placeholder={<OrgMark size={56} />}
                  hasImage={logo !== null || Boolean(savedLogo)}
                  removeLabel={t("orgLogo.remove")}
                  format="image/png"
                  save={async (image) => {
                    setLogo(image);
                    setLogoDirty(true);
                  }}
                  remove={async () => {
                    setLogo(null);
                    setLogoDirty(true);
                  }}
                  onSaved={() => setLogoOpen(false)}
                  onRemoved={() => setLogoOpen(false)}
                />
                {unpaidElsewhere && <UnpaidNote orgId={unpaidElsewhere} billing={Boolean(authConfig?.billingUrl)} />}
              </div>
            )}
          </Locked>

          {inviteOnly && (
            <p className="onb__help onb__note ac-iconline" role="status">
              <Icon name="lock" size={14} />
              <span>
                {authConfig?.supportEmail
                  ? t("onboarding.workspace.inviteOnlyAsk", { email: authConfig.supportEmail })
                  : t("onboarding.workspace.inviteOnly")}
              </span>
            </p>
          )}

          {(confirmationSent || confirmFirst) && (
            <p className="onb__help onb__note ac-iconline" role="status">
              <Icon name="mail" size={14} />
              <span>
                {confirmationSent ? t("onboarding.confirmation.sent", { email }) : t("onboarding.confirmation.first")}
                {!resend.data && (
                  <>
                    <br />
                    <button
                      type="button"
                      className="ac-link onb__link"
                      onClick={() => resend.mutate()}
                      disabled={resend.isPending}
                    >
                      {t("auth.sendNewLink")}
                    </button>
                  </>
                )}
              </span>
            </p>
          )}

          <div className="onb__actions">
            <Button variant="primary" size="lg" kbd={["↵"]} onClick={next} disabled={blocked || busy} loading={busy}>
              {t("onboarding.actions.continue")}
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}

/** The two answers to "What will you use agentes.chat for?" (ADR 0159), in this order. */
const PURPOSES = ["personal", "team"] as const satisfies readonly WorkspaceMode[];

/** Owning a workspace that waits for its first plan: said in place, with the way to that plan. */
function UnpaidNote({ orgId, billing }: { orgId: string; billing: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      <p className="onb__status ac-iconline" role="alert">
        <Icon name="pause" size={14} />
        <span>{t("standing.createUnpaid")}</span>
      </p>
      {billing && (
        <div className="row">
          <BillingLinkButton orgId={orgId} from="new_workspace" icon="external">
            {t("standing.billing.cta.payment")}
          </BillingLinkButton>
        </div>
      )}
    </>
  );
}
