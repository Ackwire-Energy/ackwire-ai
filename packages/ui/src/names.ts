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
 * Where apps keep keys and sign-ins, whatever the format: env files, auth and token files, keys, the config files of
 * tools that keep a token, credential folders and browser profiles. An import never reads these, only lists them.
 */
const SECRET_PATH = new RegExp(
  [
    "(?:^|/)\\.env(?:[./][^/]*)?$",
    "(?:^|/)[^/]+\\.env$",
    "(?:^|/)\\.envrc$",
    "(?:^|/)auth[^/]*\\.json$",
    "(?:^|/)(?![^/]*\\.(?:md|markdown)$)[^/]*(?:token|oauth|secret|credential|password|cookie)[^/]*$",
    "(?:^|/)[^/]*private[^/]*key[^/]*$",
    "\\.(?:pem|key|p8|p12|pfx|ppk|jks|keystore|kdbx|gpg|asc|ovpn|tfvars(?:\\.json)?)$",
    "(?:^|/)id_(?:rsa|dsa|ecdsa|ed25519)[^/]*$",
    "(?:^|/)\\.?npmrc$",
    "(?:^|/)(?:[._]netrc|\\.pgpass|\\.htpasswd|\\.pypirc|\\.s3cfg|\\.boto|kubeconfig[^/]*)$",
    "(?:^|/)(?:honcho|mem0|cursor-session|mcp-oauth|teams_pipeline_store)\\.json$",
    "(?:^|/)(?:credentials|mcp-tokens|vault|secrets|proxy|\\.ssh|\\.aws|\\.gnupg|\\.kube|\\.docker|\\.azure)/",
    "(?:^|/)\\.config/(?:gh|gcloud)/",
    "(?:^|/)(?:chrome-debug|bot-desktop|browser-profiles?|chromium|playwright|[^/]*-profile)/",
    "(?:^|/)(?:Cookies|Login Data|Local State|Web Data)$",
  ].join("|"),
  "i",
);
export const isSecretPath = (path: string) => SECRET_PATH.test(path.replace(/\\/g, "/"));

/** A note named like a list of logins (`passwords.md`, `credentials.md`): read by an import, never copied. */
const SECRET_NOTE = /(?:^|\/)[^/]*(?:password|credential|secret)[^/]*\.(?:md|markdown)$/i;
/** Never copied into the Drive, by its name: a credential store, or a note named like one. */
export const isSecretFile = (path: string) => isSecretPath(path) || SECRET_NOTE.test(path.replace(/\\/g, "/"));

/**
 * A credential set in a file's text: `name: value`, `NAME=value`, JSON's `"name": "value"`, `_` before the name too
 * (`DB_PASSWORD`). Stricter on the value than memory's check, since a script or a doc names these all the time: a
 * placeholder (`YOUR_API_KEY`, `your-key-here`, `xxx`, `<token>`) or code (`get_token()`, `${TOKEN}`, `os.environ[…]`)
 * isn't one.
 */
const CREDENTIAL_SET =
  /(?:\b|_)(?:password|senha|passwd|secret(?:[_-]?(?:access[_-]?)?key)?|api[_ -]?key|token)["']?\s*[:=]\s*["']?([^\s"',;]{6,})/gi;
const NOT_A_VALUE = /your|xxx|changeme|example|placeholder|[<>${}()[\]]|^(?:os|process|env|self|this|config)\./i;
export const setsCredential = (text: string) =>
  [...text.matchAll(CREDENTIAL_SET)].some(([, value = ""]) => !/^[A-Z0-9_]+$/.test(value) && !NOT_A_VALUE.test(value));

/** The Drive folder an imported agent's files go in: its name, with no `/` to read as a deeper folder. */
export const driveFolder = (agentName: string) => agentName.replace(/[\\/]+/g, "-").trim() || "agent";
