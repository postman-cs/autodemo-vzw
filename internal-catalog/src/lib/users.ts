import type { ProvisioningEnv as Env } from "./provisioning-env";

const CORS_HEADERS: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

interface PostmanUser {
  id: number;
  name: string;
  username: string;
  email: string;
  roles: string[];
}

export async function handleUsers(env: Env, apiKey?: string): Promise<Response> {
  try {
    const resp = await fetch("https://api.getpostman.com/users", {
      headers: { "X-Api-Key": apiKey || env.POSTMAN_API_KEY },
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.warn("Postman /users failed:", resp.status, text);
      return jsonResponse({ users: [], error: `Postman API returned ${resp.status}` });
    }

    const body = (await resp.json()) as { data: PostmanUser[] };
    const users = (body.data || []).map((u) => ({
      id: u.id,
      name: u.name,
      username: u.username,
      email: u.email,
      roles: u.roles,
    }));

    return jsonResponse({ users }, {
      "Cache-Control": "public, max-age=300",
    });
  } catch (err) {
    console.error("Failed to fetch users:", err);
    return jsonResponse({ users: [], error: "Failed to fetch users" });
  }
}

function jsonResponse(data: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}
