/**
 * An @handle that is an id another app gave its agent, not one someone chose: it holds the start of a UUID
 * (`agent-e9665a97-c8d5-423f-ae59-25`, an OpenBot.run id cut to our 32 characters).
 */
export const isIdHandle = (handle: string) => /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(handle);

/** 1–2 letters: "Ada" → "A"; "Marina Souza" → "MS". */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0]?.[0] ?? "?").toUpperCase();
  return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
}

/**
 * Where apps keep keys and sign-ins, whatever the format: env files, auth and token files, keys, credential folders
 * and browser profiles. An import never reads these, and never copies them into the Drive.
 */
const SECRET_PATH = new RegExp(
  [
    "(?:^|/)\\.env(?:[./][^/]*)?$",
    "(?:^|/)\\.envrc$",
    "(?:^|/)\\.op\\.env$",
    "(?:^|/)auth[^/]*\\.json$",
    "(?:^|/)(?![^/]*\\.(?:md|markdown)$)[^/]*(?:token|oauth|secret|credential|password|cookie)[^/]*$",
    "(?:^|/)[^/]*private[^/]*key[^/]*$",
    "\\.(?:pem|key|p12|pfx|ppk|jks|keystore|kdbx|gpg|asc)$",
    "(?:^|/)id_(?:rsa|dsa|ecdsa|ed25519)[^/]*$",
    "(?:^|/)\\.?npmrc$",
    "(?:^|/)(?:[._]netrc|\\.pgpass|\\.htpasswd)$",
    "(?:^|/)(?:honcho|mem0|cursor-session|mcp-oauth|teams_pipeline_store)\\.json$",
    "(?:^|/)(?:credentials|mcp-tokens|vault|secrets|proxy|\\.ssh|\\.aws|\\.gnupg|\\.kube|\\.docker|\\.azure)/",
    "(?:^|/)\\.config/(?:gh|gcloud)/",
    "(?:^|/)(?:chrome-debug|bot-desktop|browser-profiles?|chromium|playwright|[^/]*-profile)/",
    "(?:^|/)(?:Cookies|Login Data|Local State|Web Data)$",
  ].join("|"),
  "i",
);
export const isSecretPath = (path: string) => SECRET_PATH.test(path.replace(/\\/g, "/"));

/** The Drive folder an imported agent's files go in: its name, with no `/` to read as a deeper folder. */
export const driveFolder = (agentName: string) => agentName.replace(/[\\/]+/g, "-").trim() || "agent";
