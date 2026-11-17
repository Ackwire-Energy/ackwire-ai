import { ValidationError } from "../errors";

/** A request header a person typed for a server by address (ADR 0186). */
export interface RequestHeader {
  name: string;
  value: string;
}

export const MAX_REQUEST_HEADERS = 10;

/** An HTTP token (RFC 9110 §5.6.2), at most 64 characters. */
const NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
/** Tab or printable ASCII: a line break in a value would start another header. */
const VALUE = /^[\t\x20-\x7E]{1,2000}$/;

/**
 * Names a person can't set: the ones the HTTP client decides for each request, and the ones the MCP SDK's streamable
 * HTTP transport sets itself (`mcp-session-id`, `mcp-protocol-version`, `last-event-id`, with `accept` and
 * `content-type`), where a typed one would be overwritten or sent twice. `__proto__` is a valid name that a plain
 * object of headers can't hold: it would be named as sent and never sent.
 */
const RESERVED: ReadonlySet<string> = new Set([
  "host",
  "content-length",
  "content-type",
  "accept",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-connection",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
  "__proto__",
]);

/**
 * The headers as they are kept: names as typed, values trimmed, in the order given. Each refusal has its own code and
 * says which header (`header`, cut to what a name may be, and `index`, its place in the list), never a value.
 * `withKey`: a key is sent too, as `Authorization`, so that name can't also be typed.
 */
export function checkRequestHeaders(headers: RequestHeader[], withKey: boolean): Record<string, string> {
  if (headers.length > MAX_REQUEST_HEADERS) {
    throw new ValidationError(`At most ${MAX_REQUEST_HEADERS} headers`, "connector.headers_too_many", {
      max: MAX_REQUEST_HEADERS,
    });
  }
  const kept: [string, string][] = [];
  const seen = new Set<string>();
  headers.forEach((typed, index) => {
    const name = typed.name.trim();
    const at = { header: name.slice(0, 64), index };
    const lower = name.toLowerCase();
    if (!NAME.test(name)) throw new ValidationError(`"${at.header}" isn't a header name`, "connector.header_name", at);
    if (RESERVED.has(lower)) {
      throw new ValidationError(`${name} is set for every request and can't be typed`, "connector.header_reserved", at);
    }
    if (seen.has(lower)) throw new ValidationError(`${name} is there twice`, "connector.header_twice", at);
    if (withKey && lower === "authorization") {
      throw new ValidationError(
        "The key is sent as Authorization: leave the key empty to type that header yourself",
        "connector.header_and_key",
        at,
      );
    }
    const value = typed.value.trim();
    if (!VALUE.test(value)) {
      throw new ValidationError(
        `${name} needs a value of 1 to 2,000 letters, digits and symbols, on one line`,
        "connector.header_value",
        at,
      );
    }
    seen.add(lower);
    kept.push([name, value]);
  });
  return Object.fromEntries(kept);
}
