import { Button, type ButtonProps } from "@agenteschat/ui";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUploadFile } from "@/api/queries";
import type { ArtifactDetail } from "@/api/types";
import { useOrg } from "@/components/org-context";
import { errorText } from "@/lib/errors";
import { fitsUpload, MAX_UPLOAD_MB } from "@/lib/files";
import { useToast } from "@/lib/toast";

/**
 * Sends files to the Drive one at a time: the 50 MB limit is checked here
 * first (a translated message, nothing sent), then the server checks again.
 * `artifactId`: a new version of that file instead of a new file.
 */
export function useDriveUpload(onUploaded?: (saved: ArtifactDetail, file: File) => void) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const mutation = useUploadFile(org.id);
  const [current, setCurrent] = useState<string | null>(null);
  const upload = async (files: File[], target?: { artifactId: string }) => {
    for (const file of files) {
      if (!fitsUpload(file)) {
        toast.show(t("files.tooLarge", { name: file.name, max: MAX_UPLOAD_MB }), "error");
        continue;
      }
      setCurrent(file.name);
      try {
        const saved = await mutation.mutateAsync(target ? { file, artifactId: target.artifactId } : { file });
        onUploaded?.(saved, file);
      } catch (error) {
        toast.show(errorText(t, error), "error");
      }
    }
    setCurrent(null);
  };
  return { upload, busy: current !== null, current };
}

/** A button that opens the file picker (the input itself stays hidden). */
export function UploadButton({
  label,
  onFiles,
  busy,
  multiple,
  size = "sm",
  variant,
  className,
}: {
  label: string;
  onFiles: (files: File[]) => void;
  busy?: boolean;
  multiple?: boolean;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button
        size={size}
        variant={variant}
        icon="upload"
        className={className}
        loading={busy}
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        {label}
      </Button>
      <input
        ref={input}
        type="file"
        hidden
        tabIndex={-1}
        multiple={multiple}
        aria-label={label}
        data-upload-input=""
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
    </>
  );
}
