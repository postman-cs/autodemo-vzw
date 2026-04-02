function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export async function verifyWebhookSignature(
  req: Request,
  signatureHeader: string,
  secret: string,
): Promise<string> {
  const rawSecret = String(secret || "").trim();
  if (!rawSecret) {
    throw new Error("GITHUB_WEBHOOK_SECRET is not configured");
  }

  const body = await req.text();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(rawSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = `sha256=${hexEncode(new Uint8Array(mac))}`;

  if (!constantTimeEquals(signatureHeader || "", expected)) {
    throw new Error("Invalid GitHub webhook signature");
  }

  return body;
}
