import type { TFunction } from "i18next";
import type { S3Input, StorageConfig, StorageProvider, StorageTestResult } from "../api/types";
import { formatBytes } from "./files";
import { keepWhole } from "./format";

/**
 * The line under the storage option in use (Settings › Storage, web and phone): what the workspace keeps there and,
 * where that is a folder on a server of its own, what its disk has left (the server never sends the Cloud's). Null
 * from a server that doesn't say.
 */
export function storageUsageLine(t: TFunction, locale: string, config: StorageConfig): string | null {
  const { usage } = config;
  if (!usage) return null;
  // Whole sizes, so a narrow card breaks the line only after its "·".
  const size = (bytes: number) => keepWhole(formatBytes(locale, bytes));
  const bytes = config.kind === "s3" ? usage.ownBucketBytes : usage.platformBytes;
  const files = bytes > 0 ? t("storage.usage.files", { size: size(bytes) }) : t("storage.usage.none");
  const disk = config.kind === "agentes" ? usage.disk : null;
  return disk ? t("storage.usage.free", { files, size: size(disk.freeBytes) }) : files;
}

// ── Connecting the workspace's own storage, service by service ──

/** The services "Connect storage" knows, in the order its list shows them. */
export const STORAGE_PROVIDERS = ["r2", "s3", "b2", "other"] as const satisfies readonly StorageProvider[];

/** What the dialog's fields hold: each service shows only the ones it asks for (`providerFields`). */
export interface StorageForm {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

export type StorageField = keyof StorageForm;

export const emptyStorageForm: StorageForm = {
  endpoint: "",
  region: "",
  bucket: "",
  prefix: "",
  pathStyle: false,
  accessKeyId: "",
  secretAccessKey: "",
};

/** The fields each service's steps ask for; the rest the app fills in (`toS3Input`). */
export const providerFields: Record<StorageProvider, readonly StorageField[]> = {
  r2: ["bucket", "accessKeyId", "secretAccessKey", "endpoint"],
  s3: ["bucket", "region", "accessKeyId", "secretAccessKey"],
  b2: ["bucket", "endpoint", "accessKeyId", "secretAccessKey"],
  other: ["endpoint", "region", "bucket", "prefix", "accessKeyId", "secretAccessKey", "pathStyle"],
};

/**
 * Amazon S3's commercial regions (the dialog's list), in the console's order of areas. Their names are translated
 * (`storage.connect.awsRegion.<code>`).
 */
export const AWS_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ca-central-1",
  "ca-west-1",
  "mx-central-1",
  "sa-east-1",
  "eu-central-1",
  "eu-central-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-south-1",
  "eu-south-2",
  "eu-north-1",
  "il-central-1",
  "me-south-1",
  "me-central-1",
  "af-south-1",
  "ap-east-1",
  "ap-south-1",
  "ap-south-2",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-4",
  "ap-southeast-5",
  "ap-southeast-7",
] as const;

/** An address as typed or pasted: `https://` added when missing; null when it isn't one. */
function addressOf(raw: string): URL | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
}

/** The bucket named in a pasted address's path (R2's bucket page shows `…r2.cloudflarestorage.com/<bucket>`). */
const bucketInPath = (url: URL | null) => url?.pathname.split("/").find(Boolean) ?? "";

/** Backblaze's endpoint names its region: `s3.<region>.backblazeb2.com`. */
export const b2RegionOf = (endpoint: string) =>
  addressOf(endpoint)
    ?.hostname.match(/^s3\.([a-z0-9-]+)\.backblazeb2\.com$/i)?.[1]
    ?.toLowerCase() ?? "";

/**
 * What the server gets for a service's fields: R2 and B2 by their endpoint's origin, path-style (both take it, and a
 * bucket name with dots keeps a valid certificate); R2's region is `auto` and B2's comes from its endpoint; Amazon S3's
 * endpoint comes from its region. Blank keys mean "keep the saved ones".
 */
export function toS3Input(provider: StorageProvider, f: StorageForm): S3Input {
  const keys: Pick<S3Input, "accessKeyId" | "secretAccessKey"> = {};
  if (f.accessKeyId.trim()) keys.accessKeyId = f.accessKeyId.trim();
  if (f.secretAccessKey.trim()) keys.secretAccessKey = f.secretAccessKey.trim();
  const url = addressOf(f.endpoint);
  const bucket = f.bucket.trim();
  if (provider === "r2") {
    const endpoint = url ? url.origin : f.endpoint.trim();
    return {
      provider,
      endpoint,
      region: "auto",
      bucket: bucket || bucketInPath(url),
      prefix: null,
      pathStyle: true,
      ...keys,
    };
  }
  if (provider === "b2") {
    const endpoint = url ? url.origin : f.endpoint.trim();
    return { provider, endpoint, region: b2RegionOf(f.endpoint), bucket, prefix: null, pathStyle: true, ...keys };
  }
  if (provider === "s3") {
    const region = f.region.trim();
    return {
      provider,
      endpoint: `https://s3.${region}.amazonaws.com`,
      region,
      bucket,
      prefix: null,
      pathStyle: false,
      ...keys,
    };
  }
  return {
    provider,
    endpoint: f.endpoint.trim(),
    region: f.region.trim(),
    bucket,
    prefix: f.prefix.trim() || null,
    pathStyle: f.pathStyle,
    ...keys,
  };
}

/** The fields a service needs that are still blank (the keys only without saved ones). */
export function missingFields(provider: StorageProvider, f: StorageForm, keysSaved: boolean): StorageField[] {
  const optional: StorageField[] = ["prefix", "pathStyle"];
  if (keysSaved) optional.push("accessKeyId", "secretAccessKey");
  // A pasted R2 address that names the bucket fills it.
  const bucket = provider === "r2" ? f.bucket.trim() || bucketInPath(addressOf(f.endpoint)) : f.bucket.trim();
  return providerFields[provider].filter((k) => {
    if (optional.includes(k)) return false;
    const value = k === "bucket" ? bucket : f[k];
    return typeof value === "string" && !value.trim();
  });
}

/** The fields as the saved settings fill them for editing (keys blank: they stay saved until replaced). */
export function storageFormOf(config: StorageConfig | undefined): StorageForm {
  const s3 = config?.s3;
  if (!s3) return emptyStorageForm;
  const provider = s3.provider ?? "other";
  // B2's endpoint as its bucket page shows it, without the scheme.
  const endpoint = provider === "b2" ? s3.endpoint.replace(/^https:\/\//, "") : s3.endpoint;
  return {
    ...emptyStorageForm,
    endpoint,
    region: s3.region,
    bucket: s3.bucket,
    prefix: s3.prefix ?? "",
    pathStyle: s3.pathStyle,
  };
}

/**
 * The IAM policy "Copy the policy" puts on the clipboard: list the bucket, and read, write and delete in it, nothing
 * else in the account.
 */
export function awsBucketPolicy(bucket: string): string {
  const arn = `arn:aws:s3:::${bucket.trim()}`;
  const policy = {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: ["s3:ListBucket"], Resource: arn },
      { Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource: `${arn}/*` },
    ],
  };
  return JSON.stringify(policy, null, 2);
}

type StepErrorKey =
  | "auth"
  | "permission"
  | "bucketMissing"
  | "region"
  | "network"
  | "address"
  | "https"
  | "internal"
  | "hostNotFound"
  | "notFound"
  | "unexpected"
  | "invalidBucket"
  | "keysRequired";

/** A failed test step's reason by its code (`storage.connect.stepError.<key>`); others keep the server's words. */
const STEP_ERRORS: Partial<Record<string, StepErrorKey>> = {
  "storage.auth": "auth",
  "storage.permission": "permission",
  "storage.bucket_missing": "bucketMissing",
  "storage.region": "region",
  "storage.network": "network",
  "storage.invalid_endpoint": "address",
  "storage.not_found": "notFound",
  "storage.unexpected": "unexpected",
  "storage.invalid_bucket": "invalidBucket",
  "storage.credentials_required": "keysRequired",
  "url.invalid": "address",
  "url.https_required": "https",
  "url.credentials": "address",
  "url.internal": "internal",
  "url.not_found": "hostNotFound",
};

export function stepErrorText(t: TFunction, step: StorageTestResult["steps"][number]): string | null {
  const key = step.code ? STEP_ERRORS[step.code] : undefined;
  return key ? t(`storage.connect.stepError.${key}`) : (step.error ?? null);
}
