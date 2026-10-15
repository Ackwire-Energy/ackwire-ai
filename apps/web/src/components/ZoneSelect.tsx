import { TimezoneSelect } from "@agenteschat/ui";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/api/queries";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { browserTimezone, zoneDisplayName } from "@/lib/routines";

/**
 * Every place a time zone is chosen: our `TimezoneSelect` with the friendly
 * names and "Sugeridos" (my browser's zone, the workspace's, the people's,
 * UTC). Never a free-text field.
 */
export function ZoneSelect({
  value,
  onChange,
  id,
  disabled,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (zone: string) => void;
  id?: string;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const settings = useSettings(org.id);
  const dir = useDirectory(org.id);
  const orgZone = settings.data?.timezone;
  const people = dir.members.map((m) => m.timezone).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `people` stands for the members' zones
  const suggested = useMemo(
    () => [browserTimezone() ?? "", orgZone ?? "", ...dir.members.map((m) => m.timezone), "UTC"].filter(Boolean),
    [orgZone, people],
  );
  return (
    <TimezoneSelect
      value={value}
      onChange={onChange}
      id={id}
      disabled={disabled}
      aria-label={ariaLabel}
      nameOf={(z) => zoneDisplayName(z, i18n.language)}
      suggested={suggested}
      labels={{
        search: t("timezone.search"),
        searchPlaceholder: t("timezone.searchPlaceholder"),
        noResults: t("timezone.noResults"),
        list: t("timezone.list"),
        groups: {
          suggested: t("timezone.group.suggested"),
          America: t("timezone.group.America"),
          Europe: t("timezone.group.Europe"),
          Africa: t("timezone.group.Africa"),
          Asia: t("timezone.group.Asia"),
          Australia: t("timezone.group.Australia"),
          Pacific: t("timezone.group.Pacific"),
          Atlantic: t("timezone.group.Atlantic"),
          Indian: t("timezone.group.Indian"),
          Antarctica: t("timezone.group.Antarctica"),
          Other: t("timezone.group.Other"),
        },
      }}
    />
  );
}
