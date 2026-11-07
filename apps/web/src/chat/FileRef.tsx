import { useArtifact } from "@agenteschat/client";
import { KIND_ICON } from "@agenteschat/client/lib/artifacts";
import { fileIcon } from "@agenteschat/client/lib/files";
import { type FileLink, filePath } from "@agenteschat/client/lib/message-links";
import { Icon } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useMaybeArtifactViewer } from "@/components/artifacts/ArtifactViewer";
import { useOrg } from "@/components/org-context";

/**
 * A file's link in a text (`parseFileLink`: the app's address, or the API's address of its bytes that a browser's
 * downloads keep), as a pill with the file's icon and name that opens it in the app, never the raw address. One the
 * reader can't open, deleted or out of reach, is the same plain "Arquivo sem acesso", as the server keeps them one.
 */
export function FileRef({ link }: { link: FileLink }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const viewer = useMaybeArtifactViewer();
  const here = link.orgId === org.id;
  const version = link.version ?? undefined;
  const query = useArtifact(link.orgId, link.artifactId, version);
  const a = query.data;
  if (query.isPending) {
    return (
      <span className="channel-ref file-ref" aria-busy="true">
        <Icon name="file" size={14} label={t("share.fileRefNone")} />
      </span>
    );
  }
  if (!a) {
    return (
      <span className="message-ref message-ref--none file-ref">
        <Icon name="lock" size={14} />
        {t("share.fileRefNone")}
      </span>
    );
  }
  const icon = a.content.kind === "file" ? fileIcon(a.content.name, a.content.contentType) : KIND_ICON[a.kind];
  const label = t("share.fileRef", { title: a.title });
  const parts = (
    <>
      <Icon name={icon} size={14} />
      {a.title}
    </>
  );
  return here && viewer ? (
    <button
      type="button"
      className="channel-ref file-ref"
      aria-label={label}
      title={label}
      onClick={() => viewer.open(a.id, version)}
    >
      {parts}
    </button>
  ) : (
    <a
      href={filePath(link.orgId, link.artifactId, version)}
      className="channel-ref file-ref"
      aria-label={label}
      title={label}
    >
      {parts}
    </a>
  );
}
