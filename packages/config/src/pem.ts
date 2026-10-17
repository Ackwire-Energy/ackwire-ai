/**
 * A PEM private key from an env var: the PEM itself, the PEM with newlines
 * written as `\n`, or base64 of the whole PEM file (one line, easy to paste
 * into a hosting panel). Throws when it's none of these.
 */
export function parsePemKey(raw: string): string {
  const value = raw.trim();
  if (value.includes("-----BEGIN")) return value.replace(/\\n/g, "\n");
  const decoded = Buffer.from(value, "base64").toString("utf8").trim();
  if (!decoded.includes("-----BEGIN")) {
    throw new Error("must be a PEM key, a PEM key with \\n for newlines, or base64 of the PEM file");
  }
  return decoded.replace(/\\n/g, "\n");
}
