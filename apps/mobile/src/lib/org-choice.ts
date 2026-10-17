/** Picks the remembered organization if the person still belongs to it, else the first one (pure). */
export function chooseOrg(orgs: readonly { id: string }[], remembered: string | null): string | null {
  if (remembered && orgs.some((o) => o.id === remembered)) return remembered;
  return orgs[0]?.id ?? null;
}
