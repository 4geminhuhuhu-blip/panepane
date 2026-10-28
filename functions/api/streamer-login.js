import { verifyPassword } from "../lib/password.js";

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

export async function onRequest({ request, env }) {
  if (request.method !== "POST") {
    return json(
      { ok: false, error: "POST method required" },
      405,
      { Allow: "POST" }
    );
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    return json(
      { ok: false, error: "Server configuration error" },
      500
    );
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid request" }, 400);
  }

  const loginId =
    typeof body.login_id === "string" ? body.login_id.trim() : "";
  const password =
    typeof body.password === "string" ? body.password : "";

  if (
    !/^[A-Za-z0-9_-]{3,40}$/.test(loginId) ||
    password.length < 8 ||
    password.length > 1024
  ) {
    return json(
      { ok: false, error: "Invalid login ID or password" },
      400
    );
  }

  const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");

  try {
    const accountUrl = new URL(
      `${baseUrl}/rest/v1/streamer_accounts`
    );

    accountUrl.searchParams.set(
      "select",
      "id,login_id,password_hash,password_salt,is_active"
    );
    accountUrl.searchParams.set("login_id", `eq.${loginId}`);
    accountUrl.searchParams.set("limit", "1");

    const accountResponse = await fetch(accountUrl.toString(), {
      headers: {
        apikey: env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      },
    });

if (!accountResponse.ok) {
  console.error(
    "streamer_accounts request failed",
    accountResponse.status
  );

  return json(
    {
      ok: false,
      error: "Login service unavailable",
      diagnosticStatus: accountResponse.status
    },
    502
  );
}

    const accounts = await accountResponse.json();
    const account = Array.isArray(accounts) ? accounts[0] : null;

    if (
      !account ||
      account.is_active !== true ||
      !(await verifyPassword(
        password,
        account.password_hash,
        account.password_salt
      ))
    ) {
      return json(
        { ok: false, error: "Invalid login ID or password" },
        401
      );
    }

    const randomBytes = crypto.getRandomValues(
      new Uint8Array(32)
    );

    const token = Array.from(randomBytes)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    const tokenHash = await sha256Hex(token);
    const expiresAt = new Date(
      Date.now() + 8 * 60 * 60 * 1000
    );

    const insertResponse = await fetch(
      `${baseUrl}/rest/v1/streamer_sessions`,
      {
        method: "POST",
        headers: {
          apikey: env.SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          streamer_id: account.id,
          token_hash: tokenHash,
          expires_at: expiresAt.toISOString(),
        }),
      }
    );

    if (!insertResponse.ok) {
      return json(
        { ok: false, error: "Could not create session" },
        502
      );
    }

    const cookie = [
      `panepan_streamer_session=${token}`,
      "Path=/",
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      "Max-Age=28800",
    ].join("; ");

    return json(
      { ok: true, message: "Streamer login successful" },
      200,
      { "Set-Cookie": cookie }
    );
  } catch {
    return json(
      { ok: false, error: "Login service unavailable" },
      502
    );
  }
}
