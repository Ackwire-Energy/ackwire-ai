import { type ArtifactKind, useIdRef } from "@agenteschat/client";
import { KIND_ICON } from "@agenteschat/client/lib/artifacts";
import { fileIcon } from "@agenteschat/client/lib/files";
import { Icon } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { MessageRef } from "@/chat/MessageRef";
import { artifactLink, useMaybeArtifactViewer } from "@/components/artifacts/ArtifactViewer";
import { useInPlace } from "@/components/InPlace";
import { useOrg } from "@/components/org-context";
import type { IdRenderer } from "@/lib/markdown";
import { inPlaceClick } from "@/lib/navigate";

/**
 * An internal id written in a text (`splitIdRefs`), as the pill of what it names for this reader: a file (its icon and
 * name, opening it), a task ("#13 title", opening it), a message (its link's pill). While it loads, a quiet pill, so
 * the id never shows on its way to its name; one that names nothing the reader sees stays as written (`shown`: as its
 * code span, when it was one).
 */
export function IdRef({ id, text, shown }: { id: string; text: string; shown?: ReactNode }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const viewer = useMaybeArtifactViewer();
  const inPlace = useInPlace();
  const query = useIdRef(org.id, id);
  const ref = query.data;
  if (query.isPending) {
    return (
      <span className="channel-ref id-ref" aria-busy="true">
        <Icon name="more" />
      </span>
    );
  }
  if (!ref) return shown ?? <>{text}</>;
  if (ref.kind === "message") {
    const m = ref.message;
    return (
      <MessageRef
        link={{
          orgId: org.id,
          messageId: m.id,
          channelId: m.threadId ? null : m.channelId,
          threadId: m.threadId,
        }}
      />
    );
  }
  if (ref.kind === "task") {
    const number = ref.number;
    return (
      <Link
        to="/org/$orgId/issues/$number"
        params={{ orgId: org.id, number: String(number) }}
        className="channel-ref id-ref"
        onClick={inPlace ? (e) => inPlaceClick(e, () => inPlace.issue(number)) : undefined}
      >
        <Icon name="issues" />#{number} {ref.title}
      </Link>
    );
  }
  const icon =
    ref.artifactKind === "file"
      ? fileIcon(ref.fileName ?? ref.title, ref.contentType ?? "")
      : (KIND_ICON[ref.artifactKind as ArtifactKind] ?? "file");
  // A link, as a #channel's: inline, so a long name wraps with the words around it; a click opens the viewer here.
  return (
    <a
      href={artifactLink("", org.id, ref.id)}
      className="channel-ref id-ref"
      aria-label={t("artifacts.open", { title: ref.title })}
      onClick={viewer ? (e) => inPlaceClick(e, () => viewer.open(ref.id)) : undefined}
    >
      <Icon name={icon} />
      {ref.title}
    </a>
  );
}

/** The renderer to pass to `<Markdown idRef>` where people read what agents write: chat, tasks, the wiki. */
export const renderIdRef: IdRenderer = (id, text, key, shown): ReactNode => (
  <IdRef key={key} id={id} text={text} shown={shown} />
);
