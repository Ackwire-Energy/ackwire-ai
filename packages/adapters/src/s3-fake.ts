import { createHash, createHmac } from "node:crypto";
import type { S3Fetch } from "./s3";

/**
 * An in-process S3 server for tests (no network): path-style and
 * virtual-hosted requests, SigV4 checked against the expected key pair and
 * region, PUT / GET / DELETE / ListObjectsV2, and switches for the failures a
 * storage test must explain (wrong key, missing bucket, wrong region, no
 * write or delete permission).
 */
export function createFakeS3(options: {
  /** Host of the endpoint, e.g. `s3.example.com`. */
  host: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  buckets: string[];
}) {
  const buckets = new Map<string, Map<string, { body: Uint8Array; contentType: string }>>(
    options.buckets.map((b) => [b, new Map()]),
  );
  const state = { denyWrite: false, denyDelete: false, requests: 0 };

  const xmlError = (status: number, code: string, message: string) =>
    new Response(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`, {
      status,
      headers: { "content-type": "application/xml" },
    });

  const sha = (d: string | Uint8Array) => createHash("sha256").update(d).digest("hex");
  const hmac = (k: string | Buffer, d: string) => createHmac("sha256", k).update(d).digest();

  function checkSignature(method: string, url: URL, headers: Headers, body: Uint8Array): Response | null {
    const presigned = url.searchParams.get("X-Amz-Signature");
    const auth = headers.get("authorization") ?? "";
    const credential = presigned
      ? (url.searchParams.get("X-Amz-Credential") ?? "")
      : (/Credential=([^,]+)/.exec(auth)?.[1] ?? "");
    const [akid, date, region] = credential.split("/");
    if (akid !== options.accessKeyId) return xmlError(403, "InvalidAccessKeyId", "The access key does not exist.");
    if (region !== options.region)
      return xmlError(400, "AuthorizationHeaderMalformed", `the region '${region}' is wrong; expecting '${options.region}'`);
    const amzDate = presigned ? (url.searchParams.get("X-Amz-Date") ?? "") : (headers.get("x-amz-date") ?? "");
    const signedNames = (
      presigned ? (url.searchParams.get("X-Amz-SignedHeaders") ?? "") : (/SignedHeaders=([^,]+)/.exec(auth)?.[1] ?? "")
    ).split(";");
    const headerValue = (n: string) => (n === "host" ? url.host : (headers.get(n) ?? ""));
    const canonicalHeaders = signedNames.map((n) => `${n}:${headerValue(n).trim()}\n`).join("");
    const params = [...url.searchParams.entries()].filter(([k]) => k !== "X-Amz-Signature");
    const rfc = (s: string) =>
      encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    const query = params
      .map(([k, v]) => [rfc(k), rfc(v)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    const payloadHash = presigned ? "UNSIGNED-PAYLOAD" : (headers.get("x-amz-content-sha256") ?? "");
    if (!presigned && payloadHash !== sha(body)) return xmlError(400, "XAmzContentSHA256Mismatch", "Bad payload hash");
    const canonicalRequest = [method, url.pathname, query, canonicalHeaders, signedNames.join(";"), payloadHash].join(
      "\n",
    );
    const scope = `${date}/${region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha(canonicalRequest)].join("\n");
    const key = hmac(hmac(hmac(hmac(`AWS4${options.secretAccessKey}`, date ?? ""), region ?? ""), "s3"), "aws4_request");
    const expected = createHmac("sha256", key).update(stringToSign).digest("hex");
    const got = presigned ?? /Signature=([0-9a-f]+)/.exec(auth)?.[1] ?? "";
    if (got !== expected) return xmlError(403, "SignatureDoesNotMatch", "The request signature does not match.");
    return null;
  }

  const fetch: S3Fetch = async (input, init) => {
    state.requests++;
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const body =
      init.body instanceof Uint8Array
        ? init.body
        : init.body
          ? new Uint8Array(await new Response(init.body).arrayBuffer())
          : new Uint8Array();
    let bucketName: string;
    let key: string;
    if (url.host === options.host) {
      const [, b = "", ...rest] = url.pathname.split("/");
      bucketName = decodeURIComponent(b);
      key = rest.map(decodeURIComponent).join("/");
    } else if (url.host.endsWith(`.${options.host}`)) {
      bucketName = url.host.slice(0, -options.host.length - 1);
      key = url.pathname.slice(1).split("/").map(decodeURIComponent).join("/");
    } else {
      throw new TypeError(`fetch failed: unknown host ${url.host}`);
    }
    const denied = checkSignature(method, url, headers, body);
    if (denied) return denied;
    const bucket = buckets.get(bucketName);
    if (!bucket) return xmlError(404, "NoSuchBucket", "The specified bucket does not exist");

    if (method === "PUT") {
      if (state.denyWrite) return xmlError(403, "AccessDenied", "Access Denied");
      bucket.set(key, { body, contentType: headers.get("content-type") ?? "application/octet-stream" });
      return new Response(null, { status: 200 });
    }
    if (method === "DELETE") {
      if (state.denyDelete) return xmlError(403, "AccessDenied", "Access Denied");
      bucket.delete(key);
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && key === "" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const max = Number(url.searchParams.get("max-keys") ?? "1000");
      const keys = [...bucket.keys()].filter((k) => k.startsWith(prefix)).slice(0, max);
      const xml = `<?xml version="1.0"?><ListBucketResult>${keys
        .map((k) => `<Contents><Key>${k.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</Key></Contents>`)
        .join("")}</ListBucketResult>`;
      return new Response(xml, { status: 200, headers: { "content-type": "application/xml" } });
    }
    if (method === "GET") {
      const object = bucket.get(key);
      if (!object) return xmlError(404, "NoSuchKey", "The specified key does not exist.");
      return new Response(object.body, { status: 200, headers: { "content-type": object.contentType } });
    }
    return xmlError(405, "MethodNotAllowed", "Not supported by the fake");
  };

  return { fetch, buckets, state };
}
