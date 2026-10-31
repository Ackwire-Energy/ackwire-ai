import type { OrgRole } from "@agenteschat/client";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import { Button, Icon, Menu, MenuCheckboxItem, MenuHeading, MenuNote, RoleMark } from "@agenteschat/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import "./roles.css";

/**
 * Picks roles (ADR 0085) from a menu that stays open: only the ones the person may give (below their own). The
 * trigger is a field-like button that names what's picked ("Só Todos" with none), or `trigger` (a "+" on a
 * person's row).
 */
export function RolesPicker({
  roles,
  value,
  onChange,
  label,
  trigger,
  size,
}: {
  roles: readonly OrgRole[];
  value: readonly string[];
  onChange: (roleIds: string[]) => void;
  /** What the menu is for (its accessible name). */
  label: string;
  trigger?: ReactNode;
  size?: "sm";
}) {
  const { t } = useTranslation();
  const givable = sortRoles(roles.filter((r) => !isEveryone(r) && r.givable));
  const picked = sortRoles(roles.filter((r) => value.includes(r.id)));
  const toggle = (id: string, on: boolean) =>
    onChange(on ? [...new Set([...value, id])] : value.filter((v) => v !== id));
  return (
    <Menu
      label={label}
      align="end"
      trigger={
        trigger ?? (
          <Button size={size} className="roles-picker" aria-label={label}>
            <span className="roles-picker__value">
              {picked.length ? picked.map((r) => r.name).join(", ") : t("members.onlyEveryone")}
            </span>
            <Icon name="chevronDown" size={16} />
          </Button>
        )
      }
    >
      <MenuHeading>{label}</MenuHeading>
      {givable.map((r) => (
        <MenuCheckboxItem key={r.id} checked={value.includes(r.id)} onCheckedChange={(on) => toggle(r.id, on)}>
          <span className="roles-picker__item">
            <RoleMark color={r.color} icon={r.icon} size={18} />
            {r.name}
          </span>
        </MenuCheckboxItem>
      ))}
      <MenuNote>{givable.length ? t("members.everyoneNote") : t("members.noRolesToGive")}</MenuNote>
    </Menu>
  );
}
