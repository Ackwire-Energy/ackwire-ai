/**
 * Names in agents' database rules (ADR 0039): `schema.table` and `schema.table.column` written as SQL, each part
 * a plain identifier or a quoted one (`dbo.clientes."CPF/CNPJ Emitente"`). Mirrored in
 * `@agenteschat/client/lib/databases` (`apps/server/test/database-identifiers.test.ts` keeps the two the same).
 */

const PLAIN = /^[a-z_][a-z0-9_$]*$/;

/** One name as SQL: as is when Postgres would read it back unchanged, else double-quoted. */
export const quoteIdent = (name: string) => (PLAIN.test(name) ? name : `"${name.replace(/"/g, '""')}"`);

/** Names → `a.b.c`, quoted where needed (the form rules are stored in). */
export const identPath = (parts: string[]) => parts.map(quoteIdent).join(".");

/**
 * `a.b`, `"A b".c`… → the exact names, as Postgres resolves them: quoted parts as written, plain ones lowercased.
 * An unquoted part that isn't a plain identifier is taken as written (rules saved before quoting existed).
 * One part short gets `public` in front; null when the count is wrong, a part is empty or a quote is open.
 */
export function parseIdentPath(text: string, count: number): string[] | null {
  const parts: string[] = [];
  let i = 0;
  const s = text.trim();
  while (i <= s.length) {
    while (s[i] === " ") i++;
    if (s[i] === '"') {
      let name = "";
      i++;
      for (;;) {
        if (i >= s.length) return null;
        if (s[i] === '"') {
          if (s[i + 1] !== '"') break;
          name += '"';
          i += 2;
        } else name += s[i++];
      }
      i++;
      while (s[i] === " ") i++;
      if (i < s.length && s[i] !== ".") return null;
      if (!name) return null;
      parts.push(name);
    } else {
      const end = s.indexOf(".", i);
      const raw = s.slice(i, end === -1 ? s.length : end).trim();
      if (!raw || raw.includes('"')) return null;
      parts.push(/^[A-Za-z_][A-Za-z0-9_$]*$/.test(raw) ? raw.toLowerCase() : raw);
      i = end === -1 ? s.length : end;
    }
    i++;
  }
  if (parts.length === count - 1) parts.unshift("public");
  return parts.length === count ? parts : null;
}
