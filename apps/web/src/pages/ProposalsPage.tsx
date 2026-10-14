import { Alert, Avatar, Button, Card, Chip, Diff, diffLines, EmptyState, Field, Icon, Textarea } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ApiError } from "@/api/http";
import { useDecideProposal, useProposals } from "@/api/queries";
import type { Proposal } from "@/api/types";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { relativeTime, whenAt } from "@/lib/format";
import { agentGrammar } from "@/lib/grammar";
import { useToast } from "@/lib/toast";

/** Pending first, then decided; newest first inside each. */
export function sortProposals(list: Proposal[]) {
  return [...list].sort((a, b) => {
    if ((a.status === "pending") !== (b.status === "pending")) return a.status === "pending" ? -1 : 1;
    return a.createdAt < b.createdAt ? 1 : -1;
  });
}

/** telas/Propostas.dc.html — list + detail with evidence and a neutral before/after diff. */
export function ProposalsPage({ agentId }: { agentId?: string }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const proposals = useProposals(org.id);
  const decide = useDecideProposal(org.id);
  const list = useMemo(() => sortProposals(proposals.data ?? []), [proposals.data]);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [staleError, setStaleError] = useState<string | null>(null);
  const toast = useToast();
  const onDecideError = (error: unknown) => {
    if (error instanceof ApiError && error.status === 409) setStaleError(t("proposals.staleError"));
    else toast.show(error instanceof Error ? error.message : t("common.unknownError"), "error");
  };

  const preferred = list.find((p) => p.agentId === agentId && p.status === "pending") ?? list[0];
  const current = list.find((p) => p.id === selected) ?? preferred;
  // Pin the initial choice so deciding doesn't jump to another proposal.
  useEffect(() => {
    if (!selected && preferred) setSelected(preferred.id);
  }, [selected, preferred]);
  // Switching proposals (or a new version of one) resets the editor.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the proposal id on purpose
  useEffect(() => {
    setStaleError(null);
    setEditing(false);
    setDraft(current?.after ?? "");
  }, [current?.id, current?.after]);

  const backAgent = agentId ? dir.agentById.get(agentId) : undefined;
  const agentName = (id: string) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent");
  const targetLabel = (p: Proposal) =>
    p.target.type === "org_context"
      ? t("proposals.targetContext", { org: org.name })
      : t("proposals.targetInstructions", agentGrammar(t, agentName(p.target.agentId)));
  const statusText = (p: Proposal) =>
    p.stale
      ? t("proposals.stale")
      : p.status === "pending"
        ? p.decider.type === "user"
          ? t("proposals.waitingFor", { name: p.decider.name })
          : t("proposals.waitingAdmin")
        : p.status === "accepted"
          ? t("proposals.accepted")
          : t("proposals.refused");
  const decisionText = (p: Proposal) => {
    const when = p.decidedAt ? whenAt(t, i18n.language, p.decidedAt) : t("common.now");
    const mine = p.decidedBy?.userId === me.user.id;
    const name = p.decidedBy?.name ?? "";
    if (p.status === "accepted")
      return mine ? t("proposals.acceptedByYou", { when }) : t("proposals.acceptedBy", { name, when });
    return mine ? t("proposals.refusedByYou", { when }) : t("proposals.refusedBy", { name, when });
  };

  return (
    <div className="page page--xwide page--tight">
      {backAgent && (
        <Link
          to="/org/$orgId/agents/$agentId/memory"
          params={{ orgId: org.id, agentId: backAgent.id }}
          className="ac-back"
        >
          <Icon name="chevronLeft" />
          {t("memory.title", agentGrammar(t, backAgent.name))}
        </Link>
      )}
      <header className="page__header">
        <h1 className="page-title">{t("proposals.title")}</h1>
        <p className="page-sub" style={{ maxWidth: "64ch" }}>
          {t("proposals.subtitle", { org: org.name })}
        </p>
      </header>

      {proposals.isSuccess && list.length === 0 && <EmptyState icon="agent">{t("proposals.empty")}</EmptyState>}

      {current && (
        <div className="proposals">
          <nav className="proposals__list" aria-label={t("proposals.list")}>
            {list.map((p) => (
              <button
                key={p.id}
                type="button"
                className="ac-navcard"
                aria-current={p.id === current.id ? "true" : undefined}
                onClick={() => setSelected(p.id)}
              >
                <span className="row">
                  <Avatar kind="agent" size="sm" name={agentName(p.agentId)} initials={dir.agentInitials(p.agentId)} />
                  <span style={{ fontWeight: 600 }}>{agentName(p.agentId)}</span>
                  <span className="small muted" style={{ marginLeft: "auto", fontSize: 12 }}>
                    {relativeTime(t, i18n.language, p.createdAt)}
                  </span>
                </span>
                <span style={{ fontSize: 14, lineHeight: "20px" }}>{p.title}</span>
                <span className="muted" style={{ fontSize: 12, lineHeight: "16px" }}>
                  {statusText(p)}
                </span>
              </button>
            ))}
          </nav>

          <Card as="article" className="proposals__detail" aria-labelledby="prop-title">
            <div className="row">
              <Avatar
                kind="agent"
                size="sm"
                name={agentName(current.agentId)}
                initials={dir.agentInitials(current.agentId)}
              />
              <span className="small muted">
                <Trans
                  i18nKey="proposals.proposes"
                  values={{ agent: agentName(current.agentId), target: targetLabel(current) }}
                  components={{ b: <b style={{ color: "var(--ink)" }} /> }}
                />
              </span>
              {current.stale ? (
                <Chip icon="close">{t("proposals.stale")}</Chip>
              ) : current.status === "pending" ? (
                <Chip icon="waiting" tone="waiting">
                  {current.canDecide ? t("approval.waitingYou") : statusText(current)}
                </Chip>
              ) : current.status === "accepted" ? (
                <Chip icon="check" tone="done">
                  {decisionText(current)}
                </Chip>
              ) : (
                <Chip icon="close">{decisionText(current)}</Chip>
              )}
            </div>
            <h2 id="prop-title" className="ac-card__title">
              {current.title}
            </h2>

            <section aria-label={t("proposals.why")} className="section section--tight">
              <span className="ac-eyebrow">{t("proposals.why")}</span>
              <p style={{ margin: 0 }}>{current.why}</p>
              <ul className="evidence">
                {current.evidence.map((e) => (
                  <li key={`${e.where}-${e.what}`}>
                    <Icon name="message" size={16} />
                    <span>
                      {e.where} <span className="muted">· {e.what}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section aria-label={t("proposals.changeLabel")} className="section section--tight">
              <div className="row">
                <span className="ac-eyebrow spacer">{t("proposals.change", { target: targetLabel(current) })}</span>
                {current.status === "pending" && current.canDecide && (
                  <Button variant="ghost" size="sm" onClick={() => setEditing((v) => !v)}>
                    {editing ? t("proposals.viewDiff") : t("proposals.editFirst")}
                  </Button>
                )}
              </div>
              {editing && current.status === "pending" ? (
                <Field
                  label={
                    current.target.type === "org_context" ? t("proposals.finalTextContext") : t("proposals.finalText")
                  }
                  id="prop-edit"
                  help={t("proposals.finalHelp")}
                >
                  <Textarea rows={8} value={draft} onChange={(e) => setDraft(e.target.value)} />
                </Field>
              ) : (
                <Diff
                  aria-label={t("proposals.changeLabel")}
                  addedLabel={t("proposals.added")}
                  removedLabel={t("proposals.removed")}
                  lines={diffLines(current.before.split("\n"), (editing ? draft : current.after).split("\n"))}
                />
              )}
            </section>

            {staleError && <Alert>{staleError}</Alert>}
            {current.stale && (
              <p className="small muted" style={{ margin: 0 }}>
                {t("proposals.staleNote")}
              </p>
            )}
            {current.status === "pending" && current.canDecide && !current.stale && (
              <div className="proposals__actions">
                <Button
                  variant="primary"
                  disabled={decide.isPending || !draft.trim()}
                  onClick={() =>
                    decide.mutate(
                      {
                        id: current.id,
                        decision: "accept",
                        text: editing && draft !== current.after ? draft : undefined,
                      },
                      { onError: onDecideError },
                    )
                  }
                >
                  {editing ? t("proposals.acceptEdited") : t("proposals.accept")}
                </Button>
                <Button
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ id: current.id, decision: "refuse" }, { onError: onDecideError })}
                >
                  {t("proposals.refuse")}
                </Button>
                <span className="small muted" style={{ flex: "1 1 200px" }}>
                  {t("proposals.refuseNote", agentGrammar(t, agentName(current.agentId)))}
                </span>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
