import { type ProviderId, providerOf, providersForKey } from "@agenteschat/client/lib/providers";
import { Button, ProviderLogo } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";

/**
 * Under a key field: where to create the provider's key, then for one that also sells coding plans not to use
 * that, and for one whose free tier may use what is sent to turn on billing.
 */
export function KeySite({ provider }: { provider: ProviderId }) {
  const { t } = useTranslation();
  const p = providerOf(provider);
  if (!p) return null;
  return (
    <>
      <a className="ac-link ac-link--muted" href={`https://${p.site}`} target="_blank" rel="noreferrer">
        {t("onboarding.keySite", { site: p.site })}
      </a>
      {p.plans && ` ${t("onboarding.keyNotPlan")}`}
      {p.billing && ` ${t("connectAi.key.billing")}`}
    </>
  );
}

/**
 * A key that doesn't look like the chosen provider's: why, and when other providers' keys look like it, one
 * button each so the person says whose it is.
 */
export function KeyMismatch({
  provider,
  apiKey,
  onPick,
}: {
  provider: ProviderId;
  apiKey: string;
  onPick(provider: ProviderId): void;
}) {
  const { t } = useTranslation();
  const others = providersForKey(apiKey);
  return (
    <>
      {t(`onboarding.keyInvalid.${provider}`)}
      {others.length > 0 && (
        <span className="row">
          {t("onboarding.keyFromOther")}
          {others.map((p) => (
            <Button key={p.id} size="sm" variant="ghost" onClick={() => onPick(p.id)}>
              <ProviderLogo id={p.id} size="xs" />
              {p.label}
            </Button>
          ))}
        </span>
      )}
    </>
  );
}
