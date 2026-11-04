import type { ApprovalCoverInput } from "@agenteschat/client";
import { useApprovalCovers, useDeclineApprovalCover, useMe, useSetApprovalCover } from "@agenteschat/client";
import { coveringLine } from "@agenteschat/client/lib/approval-words";
import { endOfDay, toYmd } from "@agenteschat/client/lib/format";
import { Avatar, Button, Card, CardFooter, CardHeader, DatePicker, Select, Switch } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { LoadingLine } from "@/components/Loading";
import { PrefRow } from "@/components/NoticePrefs";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";

/** "Ninguém" in the person list (Radix lists take no empty value). */
const NOBODY = "none";

/**
 * Configurações › Você › Aprovações (ADR 0138): "Quem aprova por mim" (one person, always or only while my status
 * says out, until a day, risky actions off unless turned on), each change saved at once; then the people I approve
 * for, each with "Não quero cobrir".
 */
export function ApprovalsSection() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const meId = useMe().data?.user.id ?? "";
  const dir = useDirectory(org.id);
  const covers = useApprovalCovers(org.id);
  const set = useSetApprovalCover(org.id, meId);
  const decline = useDeclineApprovalCover(org.id);
  const failed = () => toast.show(t("approvalCover.failed"), "error");
  if (!covers.data) return covers.isError ? <p className="muted">{t("approvalCover.failed")}</p> : <LoadingLine />;
  const cover = covers.data.cover;
  const save = (patch: Partial<ApprovalCoverInput>) => {
    const next = {
      mode: cover?.mode ?? "while_out",
      risky: cover?.risky ?? false,
      endsAt: cover?.endsAt ?? null,
      userId: cover?.userId ?? "",
      ...patch,
    };
    set.mutate(next.userId ? next : null, { onError: failed });
  };
  const face = (userId: string) => {
    const m = dir.memberById.get(userId);
    return <Avatar kind="person" size="xs" name={m?.name ?? ""} imageUrl={m?.image} />;
  };
  const people = dir.members
    .filter((m) => m.userId !== meId)
    .map((m) => ({ value: m.userId, label: m.name, leading: face(m.userId) }));

  return (
    <>
      <Card aria-labelledby="cover-title">
        <CardHeader
          id="cover-title"
          icon="audiencePeople"
          title={t("approvalCover.title")}
          subtitle={t("approvalCover.subtitle")}
        />
        <div className="settings-rows">
          <PrefRow
            id="cover-person"
            icon="person"
            label={t("approvalCover.person")}
            control={
              <Select
                value={cover?.userId ?? NOBODY}
                onValueChange={(userId) => save({ userId: userId === NOBODY ? "" : userId })}
                aria-label={t("approvalCover.person")}
                align="end"
                options={[{ value: NOBODY, label: t("approvalCover.nobody") }, ...people]}
              />
            }
          />
          {cover && (
            <>
              <PrefRow
                id="cover-when"
                icon="clock"
                label={t("approvalCover.when")}
                help={t("approvalCover.whenHelp")}
                control={
                  <Select
                    value={cover.mode}
                    onValueChange={(mode) => save({ mode })}
                    aria-label={t("approvalCover.when")}
                    align="end"
                    options={[
                      { value: "while_out", label: t("approvalCover.whileOut") },
                      { value: "always", label: t("approvalCover.always") },
                    ]}
                  />
                }
              />
              <PrefRow
                id="cover-until"
                icon="calendar"
                label={t("approvalCover.until")}
                control={
                  <DatePicker
                    value={cover.endsAt ? toYmd(new Date(cover.endsAt)) : null}
                    onChange={(day) => save({ endsAt: endOfDay(day) })}
                    onClear={() => save({ endsAt: null })}
                    min={toYmd(new Date())}
                    placeholder={t("approvalCover.noDate")}
                    aria-label={t("approvalCover.until")}
                    locale={i18n.language}
                    labels={{
                      previousMonth: t("common.previousMonth"),
                      nextMonth: t("common.nextMonth"),
                      choose: t("common.chooseDate"),
                      clear: t("approvalCover.clearDate"),
                    }}
                  />
                }
              />
              <PrefRow
                id="cover-risky"
                icon="alert"
                label={t("approvalCover.risky")}
                help={t(cover.risky ? "approvalCover.riskyOn" : "approvalCover.riskyOff")}
                control={
                  <Switch
                    checked={cover.risky}
                    onCheckedChange={(risky) => save({ risky })}
                    aria-label={t("approvalCover.risky")}
                    aria-describedby="cover-risky-help"
                  />
                }
              />
            </>
          )}
        </div>
        <CardFooter icon="lock">{t("approvalCover.lock")}</CardFooter>
      </Card>

      {covers.data.covering.length > 0 && (
        <Card aria-labelledby="covering-title">
          <CardHeader
            id="covering-title"
            icon="approve"
            title={t("approvalCover.coveringTitle")}
            subtitle={t("approvalCover.coveringSubtitle")}
          />
          <div className="settings-rows">
            {covers.data.covering.map((c) => (
              <PrefRow
                key={c.userId}
                id={`covering-${c.userId}`}
                lead={face(c.userId)}
                label={dir.memberById.get(c.userId)?.name ?? ""}
                help={coveringLine(t, i18n.language, c)}
                control={
                  <Button
                    size="sm"
                    loading={decline.isPending && decline.variables === c.userId}
                    onClick={() => decline.mutate(c.userId, { onError: failed })}
                  >
                    {t("approvalCover.decline")}
                  </Button>
                }
              />
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
