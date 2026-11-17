import { describe, expect, test } from "bun:test";
import type { StorageConfig, StorageProvider } from "../src/api/types";
import {
  awsBucketPolicy,
  b2RegionOf,
  emptyStorageForm,
  missingFields,
  type StorageForm,
  stepErrorText,
  storageFormOf,
  toS3Input,
} from "../src/lib/storage";

const form = (f: Partial<StorageForm>): StorageForm => ({ ...emptyStorageForm, ...f });
const keys = { accessKeyId: " AKIA1234 ", secretAccessKey: " s3cr3t " };

describe("connecting storage service by service", () => {
  test("Cloudflare R2: the endpoint's origin, region auto, path-style; a pasted bucket address names the bucket", () => {
    const pasted = "https://4f1c0a7e.r2.cloudflarestorage.com/acme-files";
    expect(toS3Input("r2", form({ endpoint: pasted, ...keys }))).toEqual({
      provider: "r2",
      endpoint: "https://4f1c0a7e.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "acme-files",
      prefix: null,
      pathStyle: true,
      accessKeyId: "AKIA1234",
      secretAccessKey: "s3cr3t",
    });
    // A bucket typed in its own field wins over the address's.
    expect(toS3Input("r2", form({ endpoint: pasted, bucket: "other" })).bucket).toBe("other");
    // The EU jurisdiction's endpoint keeps its own host.
    expect(toS3Input("r2", form({ endpoint: "4f1c0a7e.eu.r2.cloudflarestorage.com" })).endpoint).toBe(
      "https://4f1c0a7e.eu.r2.cloudflarestorage.com",
    );
  });

  test("Amazon S3: the endpoint comes from the region, virtual-hosted", () => {
    expect(toS3Input("s3", form({ bucket: "acme-files", region: "sa-east-1" }))).toEqual({
      provider: "s3",
      endpoint: "https://s3.sa-east-1.amazonaws.com",
      region: "sa-east-1",
      bucket: "acme-files",
      prefix: null,
      pathStyle: false,
    });
  });

  test("Backblaze B2: the endpoint as its bucket page shows it, the region read from it", () => {
    expect(b2RegionOf("s3.us-west-004.backblazeb2.com")).toBe("us-west-004");
    expect(b2RegionOf("https://s3.eu-central-003.backblazeb2.com/")).toBe("eu-central-003");
    expect(b2RegionOf("https://s3.amazonaws.com")).toBe("");
    expect(toS3Input("b2", form({ bucket: "acme-files", endpoint: "s3.us-west-004.backblazeb2.com" }))).toEqual({
      provider: "b2",
      endpoint: "https://s3.us-west-004.backblazeb2.com",
      region: "us-west-004",
      bucket: "acme-files",
      prefix: null,
      pathStyle: true,
    });
  });

  test("Other: today's fields as typed, blank keys kept out (the saved ones stay)", () => {
    const typed = form({
      endpoint: " https://minio.acme.test ",
      region: "us-east-1",
      bucket: "b",
      prefix: " agentes/ ",
      pathStyle: true,
    });
    expect(toS3Input("other", typed)).toEqual({
      provider: "other",
      endpoint: "https://minio.acme.test",
      region: "us-east-1",
      bucket: "b",
      prefix: "agentes/",
      pathStyle: true,
    });
  });

  test("what's missing: each service's own fields; saved keys and a pasted R2 bucket count as given", () => {
    expect(missingFields("r2", emptyStorageForm, false)).toEqual([
      "bucket",
      "accessKeyId",
      "secretAccessKey",
      "endpoint",
    ]);
    expect(missingFields("s3", emptyStorageForm, true)).toEqual(["bucket", "region"]);
    expect(missingFields("b2", form({ bucket: "b" }), false)).toEqual(["endpoint", "accessKeyId", "secretAccessKey"]);
    expect(missingFields("other", emptyStorageForm, false)).toEqual([
      "endpoint",
      "region",
      "bucket",
      "accessKeyId",
      "secretAccessKey",
    ]);
    const pasted = form({ endpoint: "https://a.r2.cloudflarestorage.com/acme", ...keys });
    expect(missingFields("r2", pasted, false)).toEqual([]);
  });

  test("editing fills the saved settings, never the keys; B2's endpoint without its scheme", () => {
    const config = (provider: StorageProvider | null) =>
      ({
        kind: "s3",
        s3: {
          provider,
          endpoint: "https://s3.us-west-004.backblazeb2.com",
          region: "us-west-004",
          bucket: "acme-files",
          prefix: null,
          pathStyle: true,
          accessKeyIdHint: "••••1234",
          secretHint: "••••9876",
        },
      }) as StorageConfig;
    expect(storageFormOf(config("b2"))).toEqual(
      form({
        endpoint: "s3.us-west-004.backblazeb2.com",
        region: "us-west-004",
        bucket: "acme-files",
        pathStyle: true,
      }),
    );
    expect(storageFormOf(config(null)).endpoint).toBe("https://s3.us-west-004.backblazeb2.com");
    expect(storageFormOf(undefined)).toEqual(emptyStorageForm);
  });

  test("the copied IAM policy reaches this bucket alone: list it, read, write and delete in it", () => {
    const policy = JSON.parse(awsBucketPolicy(" acme-files "));
    expect(policy.Statement).toEqual([
      { Effect: "Allow", Action: ["s3:ListBucket"], Resource: "arn:aws:s3:::acme-files" },
      {
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        Resource: "arn:aws:s3:::acme-files/*",
      },
    ]);
  });

  test("a failed step reads by its code; an unknown code or none keeps the server's words", () => {
    const t = ((key: string) => `t:${key}`) as never;
    expect(
      stepErrorText(t, { step: "write", ok: false, error: "The key has no permission", code: "storage.permission" }),
    ).toBe("t:storage.connect.stepError.permission");
    expect(stepErrorText(t, { step: "write", ok: false, error: "Invalid address", code: "url.invalid" })).toBe(
      "t:storage.connect.stepError.address",
    );
    expect(stepErrorText(t, { step: "write", ok: false, error: "Odd answer (500)", code: "storage.other" })).toBe(
      "Odd answer (500)",
    );
    expect(stepErrorText(t, { step: "write", ok: false, error: "Older server" })).toBe("Older server");
  });
});
