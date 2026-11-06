import type { Artifact, ArtifactKind } from "@agenteschat/client";
import { useArtifacts, useChannels } from "@agenteschat/client";
import { mayAsk } from "@agenteschat/client/lib/audience";
import { relativeTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Button, Card, EmptyState, Icon, SearchField, Segmented, Toolbar } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AskAgentButton } from "@/components/AskAgentButton";
import { useArtifactViewer, useAuthorName } from "@/components/artifacts/ArtifactViewer";
import { DrivePreview } from "@/components/drive/DrivePreview";
import { LoadingLine } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { lookOf } from "@/lib/look";
import { CardHead, useAgentEdit } from "./context";

const KINDS: ArtifactKind[] = ["document", "table", "file", "diagram", "html", "diff"];

/**
 * Arquivos: the Drive files this agent made or changed, newest first,
 * each with where it came from and how many versions; opening one opens it as the Drive does. Only
 * files of conversations the viewer sees (the Drive's own visibility).
 */
export function FilesTab() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const { agent } = useAgentEdit();
  const g = agentGrammar(agent.name);
  const files = useArtifacts(org.id, { author: { type: "agent", id: agent.id }, changed: true });
  const channels = useChannels(org.id);
  const viewer = useArtifactViewer();
  const authorName = useAuthorName();
  const [kind, setKind] = useState<ArtifactKind | "all">("all");
  const [q, setQ] = useState("");
  const list = files.data ?? [];
  const count = (k: ArtifactKind) => list.filter((a) => a.kind === k).length;
  const query = q.trim().toLowerCase();
  const channelName = (id: string | null) => {
    const c = id ? channels.data?.find((x) => x.id === id) : undefined;
    return c ? `#${c.name}` : t("artifacts.noChannel");
  };
  const shown = list.filter(
    (a) =>
      (kind === "all" || a.kind === kind) &&
      (!query || `${a.title} ${channelName(a.channelId)}`.toLowerCase().includes(query)),
  );
  const sub = (a: Artifact) =>
    [
      t(`artifacts.kind.${a.kind}`),
      a.version > 1 ? t("artifacts.version", { version: a.version }) : null,
      a.createdBy.type === "agent" && a.createdBy.id === agent.id
        ? null
        : t("agentPage.files.changedOther", { ...g, owner: authorName(a.createdBy) }),
      channelName(a.channelId),
      relativeTime(t, i18n.language, a.updatedAt),
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <Card as="section" className="agp-card" aria-labelledby="agent-files">
      <CardHead
        id="agent-files"
        icon="drive"
        title={t("agentPage.files.title", g)}
        subtitle={t("agentPage.files.subtitle", g)}
        action={
          <Link className="agp-more" to="/org/$orgId/drive" params={{ orgId: org.id }}>
            {t("agentPage.files.drive")}
            <Icon name="arrowRight" size={14} />
          </Link>
        }
      />
      {list.length > 0 && (
        <Toolbar
          size="sm"
          className="agp-toolbar agp-toolbar--in"
          search={
            <SearchField
              size="sm"
              aria-label={t("drive.search")}
              placeholder={t("agentPage.files.search")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onClear={() => setQ("")}
              clearLabel={t("filters.clearSearch")}
            />
          }
        >
          <Segmented
            size="sm"
            label={t("drive.kind")}
            value={kind}
            onValueChange={setKind}
            options={[
              { value: "all" as const, label: t("agentPage.files.all"), count: list.length },
              ...KINDS.filter((k) => count(k) > 0).map((k) => ({
                value: k,
                label: t(`drive.kindMany.${k}`),
                count: count(k),
              })),
            ]}
          />
        </Toolbar>
      )}
      {files.isLoading ? (
        <LoadingLine width={260} />
      ) : list.length === 0 ? (
        <EmptyState
          size="panel"
          agent={lookOf(agent) ?? true}
          title={mayAsk(org, agent) ? t("agentPage.files.empty") : undefined}
          actions={
            <AskAgentButton
              agent={agent}
              variant="primary"
              label={t("agentPage.files.ask")}
              draft={t("agentPage.files.askText")}
            />
          }
        >
          {t("agentPage.files.emptyText", g)}
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState
          size="inline"
          actions={
            <Button
              size="sm"
              onClick={() => {
                setKind("all");
                setQ("");
              }}
            >
              {t("drive.clear")}
            </Button>
          }
        >
          {t("drive.noResults")}
        </EmptyState>
      ) : (
        <ul className="agp-list agp-files">
          {shown.map((a) => (
            <li key={a.id} className="agp-file">
              <DrivePreview artifact={a} size="sm" />
              <span className="agp-file__text">
                <button type="button" className="agp-file__title" onClick={() => viewer.open(a.id)}>
                  {a.title}
                </button>
                <span className="small muted">{sub(a)}</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => viewer.open(a.id)}>
                {t("artifacts.openFile")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {list.length > 0 && (
        <p className="agp-files__note small muted ac-iconline">
          <Icon name="info" size={14} />
          {t("agentPage.files.note")}
        </p>
      )}
    </Card>
  );
}
