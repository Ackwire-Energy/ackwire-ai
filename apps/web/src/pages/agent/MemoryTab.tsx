import type { Proposal } from "@agenteschat/client";
import { ApiError, keys, useDecideProposal, useMemory, useProposals } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  Alert,
  Button,
  Card,
  CardHeader,
  Chip,
  Diff,
  diffLines,
  Field,
  Icon,
  SearchField,
  Segmented,
  Textarea,
  Toolbar,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { HelpLink } from "@/components/HelpLink";
import { LoadingLine } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { filterMemories, KIND_ICON, type MemoryTab as Kind, memorySource, usageLabel } from "@/pages/MemoryPage";
import { proposalTitle } from "@/pages/ProposalsPage";
import { CardHead, useAgentEdit } from "./context";
import { Cell } from "./Work";

/** A proposal to change this agent's instructions: why, the diff, and Aceitar / Editar antes / Recusar. */
function ProposalCard({ proposal }: { proposal: Proposal }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const { agent } = useAgentEdit();
  const decide = useDecideProposal(org.id);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(proposal.after);
  const [stale, setStale] = useState(false);
  const g = agentGrammar(t, agent.name);
  const onError = (error: unknown) => {
    if (error instanceof ApiError && error.status === 409) setStale(true);
    else toast.show(error instanceof Error ? error.message : t("common.unknownError"), "error");
  };
  const accept = () =>
    decide.mutate(
      { id: proposal.id, decision: "accept", text: editing && text !== proposal.after ? text : undefined },
      {
        onSuccess: () => {
          // The instructions changed on the server.
          void qc.invalidateQueries({ queryKey: keys.agents(org.id) });
          void qc.invalidateQueries({ queryKey: keys.agentDetail(org.id, agent.id) });
          toast.show(t("agentPage.memory.accepted"));
        },
        onError,
      },
    );
  const refuse = () =>
    decide.mutate(
      { id: proposal.id, decision: "refuse" },
      { onSuccess: () => toast.show(t("agentPage.memory.refused", g)), onError },
    );
  const canDecide = proposal.canDecide && !proposal.stale;
  return (
    <Card as="article" className="agp-card agp-prop" aria-labelledby={`prop-${proposal.id}`}>
      <CardHeader
        id={`prop-${proposal.id}`}
        icon="document"
        title={proposalTitle(t, proposal, org.name, () => agent.name)}
        action={
          proposal.stale ? (
            <Chip icon="close">{t("proposals.stale")}</Chip>
          ) : (
            <Chip icon="waiting" tone="waiting">
              {proposal.canDecide
                ? t("approval.waitingYou")
                : proposal.decider.type === "user"
                  ? t("proposals.waitingFor", { name: proposal.decider.name })
                  : t("proposals.waitingAdmin")}
            </Chip>
          )
        }
      />
      <p className="agp-why">
        <b>{t("proposals.why")}:</b> {proposal.why}
      </p>
      {editing ? (
        <Field label={t("proposals.finalText")} id={`prop-edit-${proposal.id}`}>
          <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      ) : (
        <Diff
          aria-label={t("proposals.changeLabel")}
          addedLabel={t("proposals.added")}
          removedLabel={t("proposals.removed")}
          lines={diffLines(proposal.before.split("\n"), proposal.after.split("\n"))}
        />
      )}
      {(stale || proposal.stale) && <Alert>{t("proposals.staleNote")}</Alert>}
      {canDecide && !stale ? (
        <>
          <div className="agp-row">
            <Button
              size="sm"
              variant="primary"
              icon="check"
              disabled={decide.isPending || !text.trim()}
              onClick={accept}
            >
              {editing ? t("proposals.acceptEdited") : t("proposals.accept")}
            </Button>
            <Button size="sm" icon="edit" onClick={() => setEditing((v) => !v)}>
              {editing ? t("proposals.viewDiff") : t("proposals.editFirst")}
            </Button>
            <Button size="sm" variant="ghost" disabled={decide.isPending} onClick={refuse}>
              {t("proposals.refuse")}
            </Button>
          </div>
          <span className="small muted">{t("proposals.refuseNote", g)}</span>
        </>
      ) : (
        !proposal.canDecide && (
          <span className="small muted">
            {proposal.decider.type === "user"
              ? t("agentPage.memory.decides", { who: proposal.decider.name })
              : t("agentPage.memory.adminDecides")}
          </span>
        )
      )}
    </Card>
  );
}

/** Memória: proposals waiting, then what the agent knows (facts and decisions, lessons, archived) with search. */
export function MemoryTab() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const { agent, g } = useAgentEdit();
  const memory = useMemory(org.id, agent.id);
  const proposals = useProposals(org.id);
  const [kind, setKind] = useState<Kind>("known");
  const [q, setQ] = useState("");
  const list = memory.data ?? [];
  const pending = (proposals.data ?? []).filter(
    (p) => p.agentId === agent.id && p.status === "pending" && p.target.type === "agent_instructions",
  );
  const count = (k: Kind) => filterMemories(list, k, "").length;
  const shown = filterMemories(list, kind, q);
  return (
    <>
      <section className="agp-workcard" aria-label={t("agentPage.memory.counts")}>
        <div className="agp-cells">
          <Cell
            icon={<Icon name="book" size={16} />}
            label={t("memory.tabs.known")}
            value={count("known")}
            sub={t("agentPage.memory.verified", { count: list.filter((m) => !m.archived && m.verified).length })}
          />
          <Cell
            icon={<Icon name="agent" size={16} />}
            label={t("agentPage.memory.lessons")}
            value={count("lessons")}
            sub={t("agentPage.memory.fromTeam")}
          />
          <Cell
            icon={<Icon name="document" size={16} />}
            label={t("agentPage.memory.proposals")}
            value={pending.length}
            sub={pending.length ? t("agentPage.memory.waiting") : t("agentPage.memory.noneWaiting")}
          />
        </div>
      </section>
      <div className="agp-cols">
        <div className="agp-col">
          {pending.map((p) => (
            <ProposalCard key={p.id} proposal={p} />
          ))}
          <Card as="section" className="agp-card" aria-labelledby="mem-known">
            <CardHead
              id="mem-known"
              icon="book"
              title={t("memory.title", g)}
              action={
                <Link
                  className="agp-more"
                  to="/org/$orgId/agents/$agentId/memory"
                  params={{ orgId: org.id, agentId: agent.id }}
                >
                  {t("agentPage.memory.full")}
                  <Icon name="arrowRight" size={14} />
                </Link>
              }
            />
            <Toolbar
              size="sm"
              className="agp-toolbar agp-toolbar--in"
              search={
                <SearchField
                  size="sm"
                  aria-label={t("memory.search")}
                  placeholder={t("memory.searchPlaceholder", g)}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onClear={() => setQ("")}
                  clearLabel={t("filters.clearSearch")}
                />
              }
            >
              <Segmented
                size="sm"
                label={t("memory.tabsLabel")}
                value={kind}
                onValueChange={setKind}
                options={(["known", "lessons", "archived"] as const).map((k) => ({
                  value: k,
                  label: t(k === "lessons" ? "agentPage.memory.lessons" : `memory.tabs.${k}`),
                  count: count(k),
                }))}
              />
            </Toolbar>
            {memory.isLoading ? (
              <LoadingLine width={260} />
            ) : shown.length === 0 ? (
              <div className="agp-empty">
                <b>{q.trim() ? t("memory.emptySearch", { q }) : t("memory.empty", g)}</b>
              </div>
            ) : (
              <ul className="agp-list agp-mems">
                {shown.map((m) => (
                  <li key={m.id} className="agp-mem">
                    <span>{m.text}</span>
                    <span className="agp-chips">
                      <Chip icon={KIND_ICON[m.kind]}>{t(`memory.kinds.${m.kind}`)}</Chip>
                      {m.lowTrust ? (
                        <Chip icon="alert" tone="waiting">
                          {t("memory.lowTrust")}
                        </Chip>
                      ) : m.verified ? (
                        <Chip icon="check">{t("memory.verified")}</Chip>
                      ) : (
                        <Chip icon="info">{t("memory.unverified")}</Chip>
                      )}
                      {m.pinned && <Chip icon="pin">{t("memory.pinned")}</Chip>}
                      <span className="small muted">
                        {usageLabel(t, m)} · {memorySource(t, i18n.language, m)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="agp-col">
          <p className="page__note">
            <HelpLink slug="memory">{t("memory.how")}</HelpLink>
          </p>
        </div>
      </div>
    </>
  );
}
