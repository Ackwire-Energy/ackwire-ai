import { type Person, useRemovalPreview, useRemoveMember } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { removalLines } from "@agenteschat/client/lib/removal";
import { Alert, Button, Dialog, DialogBody, DialogFooter } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";

/**
 * "Remover do workspace" (or "Sair do workspace" on one's own row): says what goes with the person, as the server
 * reads it (`GET …/members/{userId}/removal`, refused as the removal would be), then removes them.
 */
export function RemoveMemberDialog({
  person,
  onClose,
}: {
  person: Pick<Person, "userId" | "name"> | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const navigate = useNavigate();
  const remove = useRemoveMember(org.id);
  const preview = useRemovalPreview(org.id, person?.userId ?? null);
  const mine = person?.userId === me.user.id;
  const name = person?.name ?? "";
  const p = preview.data;
  const lines = p ? removalLines(t, p, { name, org: org.name, mine, meId: me.user.id }) : [];
  const confirm = () => {
    if (!person) return;
    remove.mutate(person.userId, {
      onSuccess: () => {
        onClose();
        if (mine) {
          toast.show(t("members.remove.left", { org: org.name }));
          void navigate({ to: "/", replace: true });
        } else toast.show(t("members.remove.done", { name, org: org.name }));
      },
      onError: (e) => toast.show(errorText(t, e), "error"),
    });
  };
  return (
    <Dialog
      open={person !== null}
      onOpenChange={(o) => !o && onClose()}
      title={
        mine ? t("members.remove.leaveTitle", { org: org.name }) : t("members.remove.title", { name, org: org.name })
      }
      closeLabel={t("common.close")}
      width={480}
    >
      <DialogBody>
        {preview.isLoading && <LoadingList count={3} />}
        {preview.error && <Alert>{errorText(t, preview.error)}</Alert>}
        {lines.length > 0 && (
          <ul className="members-remove__lines">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="danger" disabled={!p} loading={remove.isPending} onClick={confirm}>
          {mine ? t("members.remove.confirmLeave", { org: org.name }) : t("members.remove.confirm", { name })}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
