import { createElement, type SVGProps } from "react";
import { cx } from "../cx";
import { extraIcons } from "./extra";
import { sourceIcons } from "./source";
import type { IconShape } from "./types";

export const icons: Record<keyof typeof sourceIcons | keyof typeof extraIcons, IconShape[]> = {
  ...sourceIcons,
  ...extraIcons,
};

export type IconName = keyof typeof icons;
export const iconNames = Object.keys(icons) as IconName[];

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  /** 20 (default), 16 or 14 px. */
  size?: 14 | 16 | 18 | 20;
  /** Accessible name. Without it the icon is decorative (`aria-hidden`). */
  label?: string;
}

/** Our icon set: 20px grid, 1.6 stroke, drawn in `currentColor`. */
export function Icon({ name, size = 20, label, className, style, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      className={cx("ac-icon", className)}
      style={size === 20 ? style : { width: size, height: size, ...style }}
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      focusable="false"
      {...rest}
    >
      {icons[name].map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}
