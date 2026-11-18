# 0186. Request headers for a server by address

- Status: Accepted
- Date: 2026-11-14
- Code: engine `packages/engine/src/connectors/request-headers.ts` (`checkRequestHeaders`), `connections.ts`
  (`ConnectionSecret.headers`, `secretHeaders`, `connectionHeaders`), `custom.ts` (`connectCustomServer`,
  `storeCustomConnection`, `CustomServerView.headerNames`), `oauth-mcp.ts` (`probeMcpServer`), `mcp.ts`
  (`connectOverHttp`), `presets.ts` (`composioToolkitTyped`); schema
  `packages/db/src/schema/connectors.ts` (`header_names`, migration 0277); route
  `apps/server/src/routes/app/connectors-custom.ts`; client `packages/client/src/api/{types,client}.ts`,
  `lib/request-headers.ts`, the refusals' words in `lib/errors.ts`; web `apps/web/src/components/ConnectFlow.tsx`
  (`HeaderRows`, `HeaderNames`), `Connectors.tsx`; phone `apps/mobile/src/features/connectors/RequestHeaders.tsx`,
  `ConnectSheet.tsx`, `ConnectionScreen.tsx`, `logic.ts` (`headerNamesText`); tests
  `packages/engine/test/connector-headers.test.ts`, `apps/server/test/connectors.test.ts`,
  `apps/web/test/connector-headers.test.tsx`, `packages/client/test/request-headers-lib.test.ts`,
  `apps/mobile/test/features/connector-headers.test.ts`

## Context

A workspace connects an MCP server by address (ADR 0016) with nothing, with one key sent as
`Authorization: Bearer <key>`, or with the server's own sign-in. That leaves out servers that are otherwise ordinary:
one that wants its key in a header of its own (`X-API-Key`), one that wants another scheme
(`Authorization: Token …`), and one behind a gateway that asks for headers before a request reaches the server at
all. None of them could be connected.

## Decision

An admin may type request headers for a server by address. They are sent with every request to that server.

1. **Where they are kept.** The values live in the connection's sealed secret (`ConnectionSecret.headers`, names as
   typed), beside the key or the tokens, under the same envelope encryption. No API returns them, and nothing this
   server writes of its own (a log line, an error, an audit row) holds one. The names alone are also kept readable,
   in `header_names` on `connector_connections`, in the order typed.

   A server may repeat what it was sent in its refusal, and that text is kept as the connection's last error, logged
   and handed to the agent. So a session over HTTP (`connectOverHttp`) masks each header value it was opened with,
   the typed ones and the key or the sign-in's token with them, in every error it throws and in a tool's answer the
   server flags as an error (`isError`). A value is masked as it was typed and as a JSON body spells it (a quote, a
   backslash or a tab escaped, and a slash written `\/`). Another spelling of it (a `\u` escape, a value encoded
   twice) is not caught: a server that repeats its caller's key is the rare case, and these are rarer still. A tool's
   ordinary answer is left as it came: it is what the agent asked for.

   Only a value of 8 characters or more is masked. A shorter one is a setting such as `1` or `v2`, not a key (the
   key field itself asks for 8), and masked wherever it shows it would turn "HTTP 401" into noise.

   Why the names and not the values: a screen has to say what a server is sent ("also sends: X-API-Key") and what
   Reconectar will keep, and a listing never opens a secret. A header's name says how a server is reached, as its
   address does; its value is the credential. The names go to whoever manages connectors, as the whole address
   does; another member's listing has none.

2. **Where they go.** Only to the connection's own address, on the MCP transport's requests and on the one request
   that asks a server who it is when it is connected without a key. A redirect is followed only while it stays on
   the server's origin (`outboundFetch`'s `ownRedirects` where the address is pinned, the MCP transport's own rule
   where it isn't), so they never reach another host. They never go to a protected resource's or an authorization
   server's metadata, to a client registration, to a token endpoint (the exchange or a refresh), to a server's icon,
   to a provider's own API, or to Composio. Reconectar asks at the address the account has, however its address
   was typed again (addresses match without their case or a last slash), so the headers an account keeps are never
   sent to an address a request chose.

   One function builds what a stored secret sends, `secretHeaders`: the typed headers, then the key's or the
   sign-in's `authorization` on top. Everything that talks to a stored connection goes through it
   (`connectionHeaders`: tool calls, the tool listing, the account a connection reaches, a routine's connector
   event), and so do the two requests made before a connection is stored.

3. **What is accepted.** One validator, `checkRequestHeaders`, in the engine:

   - at most 10 headers;
   - a name is an HTTP token of 1 to 64 characters; a value is 1 to 2,000 characters once the spaces around it are
     cut, of tab and printable ASCII only, so it can't hold a line break;
   - a name can't be there twice, in any case;
   - names the HTTP client or the MCP transport set for every request are refused: `Host`, `Content-Length`,
     `Content-Type`, `Accept`, `Connection`, `Keep-Alive`, `Transfer-Encoding`, `Upgrade`, `TE`, `Trailer`,
     `Proxy-Authorization`, `Proxy-Connection`, `Mcp-Session-Id`, `Mcp-Protocol-Version`, `Last-Event-ID`; and
     `__proto__`, a valid token that a plain object of headers can't hold, so it would be named and never sent;
   - `Authorization` may be typed when no key is (another scheme), and is refused beside a key, which is sent as
     that header.

   Each refusal is a 400 with its own code and `params` that name the header (`header`) and its place in the list
   (`index`), never its value: `connector.header_name`, `connector.header_value`, `connector.header_reserved`,
   `connector.header_twice`, `connector.header_and_key`, and `connector.headers_too_many`.

4. **Connecting.** `POST …/connectors/custom` takes `headers: [{ name, value }]`.

   - With a key: both are stored, and the server is not asked first, as before.
   - Without a key: the server is asked with the headers. One that answers is connected by them alone, as
     `api_key` (it holds a secret a person typed, and a later 401 asks for Reconectar the same way). One that
     refuses still answers `needs_key`. One that asks for a sign-in is refused, `connector.headers_with_sign_in`: a
     sign-in's token would be stored in their place, and they would be gone without a word.
   - A service through Composio, and a server that only signs in on the Cloud (ADR 0107), refuse headers as they
     refuse a key (`connector.oauth_only`). Composio's address spelled another way (its port written out, a query,
     a dot after the host, a character percent-encoded, slashes repeated or left at the end) is refused the same,
     with headers or a key, before any request is made.
   - Reconectar (`connectionId`): no `headers` keeps the ones the account has, whatever else changes; `[]` removes
     them; a list replaces them all. The account's secret is opened only in the first case, and only when its row
     names headers. A secret that can't be opened then, or that holds none, is a 400
     `connector.headers_unreadable`: going on would drop the headers unsaid. A list or `[]` never opens the secret,
     so typing them again or removing them still works. An account that keeps an `Authorization` header can't take
     a key until that header is replaced or removed.

5. **What screens get.** `CustomServer.headerNames`, empty when there are none. A value can't be read back: to
   change one, the person types the list again.

6. **The form.** In the web app, connecting a server the catalog doesn't list has a closed disclosure under the
   key: one row per header, a name and a value typed as a secret, ten rows at most, and one line saying what
   headers are for and that most servers need none. A row left blank is no header. A refusal shows on the row the
   server names (`index`), in the person's language, each code with its own line and its way out; no toast repeats
   it. One about them all (the server asks for a sign-in) shows under the rows, and the disclosure opens for it.
   With headers typed and no key, the button connects by them alone instead of asking for a key. Reconectar opens
   the disclosure on the saved names: left alone, the request says nothing about headers, so they stay; "Remover"
   sends `[]`; a typed row replaces them all, and the line about the saved ones then says they go, with no link
   that would keep them. Saved ones that can't be read any more are no longer said to stay: until the form closes,
   that refusal stands where their line was, with "Remover" beside it, and nothing is removed unless the person
   chooses it or types a row. A name's field takes the 64 characters a name may have. A server's row in Conectores
   says what it also sends, by name, with Reconectar as the way to change it.

   The phone has the same in its sheet, under the key: one line that opens the rows. A sheet shows one way in at a
   time, so an account that has headers opens on the key's side, and a refusal about headers brings that side back
   with the rows open, whichever way in was tried. A connection's screen says what it also sends under Reconectar.

## Not built

- Headers together with a server's own sign-in.
- Headers for a catalog connector.
- Headers per agent.
- Values built from templates.

## Consequences

- Connections made before this have no headers and send what they sent. The migration adds one nullable column.
- A token refresh writes the new tokens over the old ones and keeps whatever else the secret holds, so a secret
  with both would keep its headers, though nothing stores one yet.
- The audit log's rows for connecting and reconnecting are as before: they name the server and how it signs in,
  not its headers.
