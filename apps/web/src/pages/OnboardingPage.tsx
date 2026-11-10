import { ApiError, keys, meQuery, useAuthConfig } from "@agenteschat/client";
import { accountOutOfReach } from "@agenteschat/client/lib/deletion";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { settingUp } from "@agenteschat/client/lib/guards";
import { sendsEmail } from "@agenteschat/client/lib/join-requests";
import {
  createWorkspace,
  finishOnboarding,
  type OpenedAt,
  RIGHT_HAND_DEFAULT,
} from "@agenteschat/client/lib/right-hand";
import { browserTimezone, timezoneName } from "@agenteschat/client/lib/routines";
import { Button, Field, Icon, Input, Locked, Logo } from "@agenteschat/ui";
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
import { BootSplash } from "@/components/Sky";
import { ZonePicker } from "@/components/ZoneSelect";
import { sendNewLink } from "@/lib/email-confirmation";
import { useOpenParam } from "@/lib/open-param";
import { returnPlace } from "@/lib/return-to";
import { STORAGE_KEYS, sessionStore, storage } from "@/lib/storage";
import { useToast } from "@/lib/toast";
import "./onboarding.css";

/**
 * The onboarding: one question, the workspace's name (with its logo and time zone), asked by its right hand; then the
 * right hand's DM, where the rest of the setup is cards (ADR 0137). A workspace still being set up from an older
 * onboarding, whatever step it was on, is finished and opened there.
 */
export function OnboardingPage() {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const auth = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();

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

  // The answer that finished it says who the person is now: it opens without asking the server again.
  const openWorkspace = async ({ orgId, agentId, me: now }: OpenedAt) => {
    sessionStore.remove(STORAGE_KEYS.confirmationSent);
    if (now) qc.setQueryData(keys.me, now);
    else await qc.invalidateQueries({ queryKey: keys.me });
    if (agentId) await navigate({ to: "/org/$orgId/dm/agent/$agentId", params: { orgId, agentId } });
    else await navigate({ to: "/org/$orgId", params: { orgId } });
  };

  const save = useMutation({
    // Owning a workspace that waits for its first plan is said in place, with the way to that plan.
    meta: { silent: true },
    onError: (e) => {
      if (errorCode(e) !== "org.create_unpaid") toast.show(errorText(t, e), "error");
    },
    mutationFn: async () => {
      const name = org.trim();
      // The person's own zone, detected here: agents read the local time from it (the language is `useServerLocale`'s).
      const memberTimezone = browserTimezone() ?? undefined;
      // Nothing to send after it: one call makes it, finished, and says where it opens.
      if (!created && !logoDirty)
        return openWorkspace(await createWorkspace(api, { name, timezone: zone, memberTimezone }));
      let target = created;
      if (!target) {
        const res = await api.orgs.create({ name, timezone: zone, memberTimezone });
        target = { orgId: res.organization.id };
        setCreated(target);
      } else {
        await api.orgs.updateSettings(target.orgId, { name, timezone: zone });
      }
      // The logo needs the workspace: picked before it existed, sent now.
      if (logoDirty) {
        if (logo) await api.orgs.setLogo(target.orgId, logo);
        else await api.orgs.removeLogo(target.orgId);
        setLogoDirty(false);
      }
      await openWorkspace(await finishOnboarding(api, target.orgId));
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
    else
      void finishOnboarding(api, unfinished.id)
        .then(openWorkspace)
        .catch((e) => toast.show(errorText(t, e), "error"));
  });

  const refused = save.error;
  const unpaidElsewhere =
    refused instanceof ApiError && refused.code === "org.create_unpaid" && typeof refused.params?.orgId === "string"
      ? refused.params.orgId
      : null;
  const blocked = !org.trim() || inviteOnly;
  const busy = save.isPending;
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
          if (e.key !== "Enter" || e.defaultPrevented || e.nativeEvent.isComposing) return;
          if (el.closest("button, a, [role='dialog'], [role='listbox'], [role='combobox']")) return;
          if (blocked || busy) return;
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="onb__body">
          {leaveTo && (
            <button
              type="button"
              className="onb__back"
              onClick={() => void navigate({ href: returnPlace(leaveTo.id) })}
              disabled={busy}
            >
              <Icon name="chevronLeft" size={16} />
              {t("onboarding.leave", { name: leaveTo.name })}
            </button>
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
            <div className="onb__bubble">
              <h1 className="onb__title">{t("onboarding.workspace.title")}</h1>
              <p className="onb__lead">{t("onboarding.workspace.lead")}</p>
            </div>
          </header>

          <Locked when={busy}>
            <div className="onb__answer">
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
              {unpaidElsewhere && (
                <>
                  <p className="onb__status ac-iconline" role="alert">
                    <Icon name="pause" size={14} />
                    <span>{t("standing.createUnpaid")}</span>
                  </p>
                  {authConfig?.billingUrl && (
                    <div className="row">
                      <BillingLinkButton orgId={unpaidElsewhere} from="new_workspace" icon="external">
                        {t("standing.billing.cta.payment")}
                      </BillingLinkButton>
                    </div>
                  )}
                </>
              )}
            </div>
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
            <Button
              variant="primary"
              size="lg"
              kbd={["↵"]}
              onClick={() => save.mutate()}
              disabled={blocked || busy}
              loading={busy}
            >
              {t("onboarding.actions.continue")}
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}
