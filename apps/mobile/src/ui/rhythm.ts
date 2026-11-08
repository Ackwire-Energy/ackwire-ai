/**
 * The phone's page rhythm, the web's (pure: unit-tested): a screen's content 16 from its sides, a toolbar's controls
 * (Segmented, Filters) 32 tall with their target grown to 44, grouped rows 44 with 8 above and below and 16 at the
 * sides. A row whose text wraps starts its label where a one-line row's sits: its 22-point line centred in 44.
 */
export const SCREEN_X = 16;
export const TOOL_H = 32;
export const TOUCH = 44;
export const GROUPED_ROW = { minHeight: 44, padX: 16, padY: 8, tallPadY: (44 - 22) / 2 } as const;
