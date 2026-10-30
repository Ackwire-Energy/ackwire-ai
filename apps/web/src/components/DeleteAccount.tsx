import { useAccountDeletionPlan, useApi, useAuthConfig } from "@agenteschat/client";
import { type AccountDeletionLine, accountDeletionLines } from "@agenteschat/client/lib/deletion";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { Alert, Button, Dialog, DialogBody, DialogFooter, type IconName } from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { DeletionLine, PasswordProof, SignInNeeded, useProof } from "@/components/DeleteWorkspace";
import { ErrorState, LoadingLine } from "@/components/Loading";
import { useToast } from "@/lib/toast";
import "./deletion.css";

const LINE_ICON: Record<AccountDeletionLine["kind"], IconName> = {
  closes: "trash",
  leaves: "arrowRight",
  computers: "computer",
  staysBehind: "key",
  messages: "message",
  serverOwner: "settings",
};

/**
 * Deleting my account (the account menu), from its preflight: a workspace that still needs me as its only owner
 * comes first, as a checklist with its two ways out. Otherwise what closes, what I leave, the computers removed, what
 * stays behind and that my messages stay without my name, then the proof and the button. Deleted: to the sign-in.
 */
export function DeleteAccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const config = useAuthConfig().data;
  const plan = useAccountDeletionPlan(open);
  const del = useMutation({
    mutationFn: (password?: string) => api.account.delete(password ? { password } : {}),
    meta: { silent: true },
    onSuccess: async () => {
      qc.clear();
      await navigate({ to: "/login" });
      toast.show(t("deleteAccount.deleted"));
    },
    // A workspace that came to need me since the preflight: it shows as a blocker.
    onError: (error) => {
      if (errorCode(error) === "sole_owner") void plan.refetch();
    },
  });
  const proof = useProof(open, errorCode(del.error));
  const { reset } = del;
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);
  const data = plan.data;
  const blockers = data?.soleOwner ?? [];
  const lines = data ? accountDeletionLines(t, i18n.language, data, { cloud: config?.workspaceComputer === true }) : [];
  const ready = data !== undefined && blockers.length === 0 && proof.ready && !del.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("deleteAccount.title")}
      closeLabel={t("common.close")}
      width={520}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) del.mutate(proof.password || undefined);
        }}
      >
        <DialogBody>
          {plan.isError ? (
            <ErrorState error={plan.error} onRetry={() => void plan.refetch()} />
          ) : !data ? (
            <LoadingLine width={320} />
          ) : blockers.length > 0 ? (
            <>
              <h3 className="ac-card__title">{t("deleteAccount.blockers")}</h3>
              <ul className="deletion-blockers">
                {blockers.map((o) => (
                  <DeletionLine key={o.id} icon="stageTodo">
                    {t("deleteAccount.soleOwner", { name: o.name })}
                    <span className="deletion-blockers__acts">
                      <Link
                        className="ac-link"
                        to="/org/$orgId/settings/$section"
                        params={{ orgId: o.id, section: "members" }}
                      >
                        {t("deleteAccount.openPeople")}
                      </Link>
                      <Link
                        className="ac-link"
                        to="/org/$orgId/settings/$section"
                        params={{ orgId: o.id, section: "general" }}
                        search={{ delete: 1 }}
                      >
                        {t("deleteAccount.deleteOrg", { name: o.name })}
                      </Link>
                    </span>
                  </DeletionLine>
                ))}
              </ul>
            </>
          ) : (
            <>
              <ul className="deletion-lines">
                {lines.map((line) => (
                  <DeletionLine key={`${line.kind}:${line.text}`} icon={LINE_ICON[line.kind]}>
                    {line.text}
                  </DeletionLine>
                ))}
              </ul>
              {proof.needs === "signIn" && <SignInNeeded />}
              {proof.needs === "password" && <PasswordProof {...proof.field} />}
              {proof.alert && errorCode(del.error) !== "sole_owner" && <Alert>{errorText(t, del.error)}</Alert>}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {blockers.length > 0 ? t("common.close") : t("common.cancel")}
          </Button>
          {blockers.length > 0 || !data ? null : proof.needs === "signIn" ? (
            <Button type="button" variant="primary" onClick={() => void proof.signInAgain()}>
              {t("proof.signInButton")}
            </Button>
          ) : (
            <Button type="submit" variant="danger" disabled={!ready} loading={del.isPending}>
              {t("deleteAccount.submit")}
            </Button>
          )}
        </DialogFooter>
      </form>
    </Dialog>
  );
}
