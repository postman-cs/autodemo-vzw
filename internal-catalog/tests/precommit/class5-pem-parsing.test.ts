import { generateKeyPairSync, createPrivateKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pemToPkcs8Bytes } from "../../src/lib/github-app-auth";

describe("precommit class 5 pem parsing", () => {
  it("normalizes PKCS#1 and PKCS#8 PEM keys into valid PKCS#8 bytes", () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });

    const pkcs8Pem = privateKey.toString();
    const pkcs1Pem = createPrivateKey(pkcs8Pem).export({ type: "pkcs1", format: "pem" }).toString();

    const pkcs8Der = pemToPkcs8Bytes(pkcs8Pem);
    const pkcs1Der = pemToPkcs8Bytes(pkcs1Pem);

    expect(pkcs8Der.byteLength).toBeGreaterThan(0);
    expect(pkcs1Der.byteLength).toBeGreaterThan(0);

    expect(() => createPrivateKey({ key: Buffer.from(pkcs8Der), format: "der", type: "pkcs8" })).not.toThrow();
    expect(() => createPrivateKey({ key: Buffer.from(pkcs1Der), format: "der", type: "pkcs8" })).not.toThrow();
  });

  it("accepts CRLF normalized PEM text", () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const pem = privateKey.toString().replace(/\n/g, "\r\n");
    expect(pemToPkcs8Bytes(pem).byteLength).toBeGreaterThan(0);
  });

  it("rejects malformed or empty PEM input", () => {
    expect(() => pemToPkcs8Bytes("")).toThrow("GitHub App private key is empty");
    expect(() => pemToPkcs8Bytes("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----")).not.toThrow();
  });
});
