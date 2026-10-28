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
  const clearCookie =
    "panepan_streamer_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";

  if (request.method !== "POST") {
    return json(
      { ok: false, error: "POST method required" },
      405,
      { Allow: "POST" }
    );
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    return json({ ok: false, error: "Server configuration error" }, 500);
  }

  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(
    /(?:^|;\s*)panepan_streamer_session=([^;]+)/
  );

  if (!match) {
    return json(
      { ok: true, message: "Already logged out" },
      200,
      { "Set-Cookie": clearCookie }
    );
  }

  let token;

  try {
    token = decodeURIComponent(match[1]);
  } catch {
    return json(
      { ok: false, error: "Invalid session" },
      400,
      { "Set-Cookie": clearCookie }
    );
  }

  if (!/^[a-f0-9]{64}$/.test(token)) {
    return json(
      { ok: false, error: "Invalid session" },
      400,
      { "Set-Cookie": clearCookie }
    );
  }

  try {
    const tokenHash = await sha256Hex(token);
    const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");
    const deleteUrl = new URL(`${baseUrl}/rest/v1/streamer_sessions`);
    deleteUrl.searchParams.set("token_hash", `eq.${tokenHash}`);

    const deleteResponse = await fetch(deleteUrl.toString(), {
      method: "DELETE",
      headers: {
        apikey: env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      },
    });

    if (!deleteResponse.ok) {
      return json(
        { ok: false, error: "Could not end session" },
        502
      );
    }

    return json(
      { ok: true, message: "Logged out" },
      200,
      { "Set-Cookie": clearCookie }
    );
  } catch {
    return json(
      { ok: false, error: "Logout service unavailable" },
      502
    );
  }
}
