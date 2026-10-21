import { keys } from "@agenteschat/client";
import { formatTimeLeft } from "@agenteschat/client/lib/actions";
import { connectLink, isTailnet } from "@agenteschat/client/lib/server";
import { Alert, Button, Dialog, DialogBody } from "@agenteschat/ui";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { encode } from "uqr";
import { useApi } from "@/api/context";
import { useNow } from "@/components/missions/MissionBits";

/** A new code this long before the one on screen expires, so a scan never meets an expired one. */
const RENEW_BEFORE_MS = 20_000;

/**
 * "Abrir no celular" (account menu): a QR code that opens the phone app on this server, signed in as this
 * person. Each code works once for a few minutes, and a new one takes its place while the dialog is open.
 */
export function OpenOnPhoneDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("shell.openOnPhone")}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogBody>{open && <PhoneCode />}</DialogBody>
    </Dialog>
  );
}

function PhoneCode() {
  const { t } = useTranslation();
  const api = useApi();
  const code = useQuery({
    queryKey: keys.phoneSignIn,
    queryFn: () => api.account.phoneSignIn(),
    // Minted fresh each time the dialog opens, never served from cache.
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (q) =>
      q.state.data ? Math.max(1000, Date.parse(q.state.data.expiresAt) - Date.now() - RENEW_BEFORE_MS) : false,
  });
  const now = useNow(code.isSuccess);

  if (code.isError)
    return (
      <div className="stack-4" style={{ gap: 12 }}>
        <Alert>{t("openOnPhone.failed")}</Alert>
        <Button onClick={() => void code.refetch()}>{t("common.retry")}</Button>
      </div>
    );

  const server = code.data?.server ?? "";
  return (
    <div className="phone-code">
      <div className="phone-code__qr">
        {code.data ? (
          <QrCode text={connectLink(code.data.server, code.data.token)} label={t("openOnPhone.qr")} />
        ) : null}
      </div>
      {code.data && (
        <span className="small muted">
          {t("openOnPhone.validFor", { time: formatTimeLeft(Math.max(0, Date.parse(code.data.expiresAt) - now)) })}
        </span>
      )}
      <ol className="machine-pair__steps small">
        <li>{t("openOnPhone.stepApp")}</li>
        {isTailnet(server) && <li>{t("openOnPhone.stepTailscale")}</li>}
        <li>{t("openOnPhone.stepScan")}</li>
      </ol>
      <span className="small muted">{t("openOnPhone.private")}</span>
    </div>
  );
}

/** Dark modules on white whatever the theme: phone cameras read that best. */
function QrCode({ text, label }: { text: string; label: string }) {
  const { size, data } = encode(text, { ecc: "M", border: 2 });
  let path = "";
  data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    });
  });
  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
