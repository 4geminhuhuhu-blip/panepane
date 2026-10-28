async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function onRequest({ request, env }) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };

  if (request.method !== "GET") {
    return new Response(
      JSON.stringify({ ok: false, error: "GET method required" }),
      { status: 405, headers: { ...headers, Allow: "GET" } }
    );
  }

  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(
    /(?:^|;\s*)panepan_streamer_session=([^;]+)/
  );

  if (!match) {
    return new Response(
      JSON.stringify({ ok: true, authenticated: false }),
      { status: 200, headers }
    );
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    return new Response(
      JSON.stringify({ ok: false, error: "Server configuration error" }),
      { status: 500, headers }
    );
  }

  try {
    const token = decodeURIComponent(match[1]);

    if (!/^[A-Za-z0-9_-]{40,200}$/.test(token)) {
      throw new Error("Invalid session token");
    }

    const tokenHash = await sha256Hex(token);
    const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");

    const sessionUrl = new URL(`${baseUrl}/rest/v1/streamer_sessions`);
    sessionUrl.searchParams.set("select", "id,streamer_id,expires_at");
    sessionUrl.searchParams.set("token_hash", `eq.${tokenHash}`);
    sessionUrl.searchParams.set("expires_at", `gt.${new Date().toISOString()}`);
    sessionUrl.searchParams.set("limit", "1");

    const sessionResponse = await fetch(sessionUrl.toString(), {
      headers: {
        apikey: env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      },
    });

    if (!sessionResponse.ok) {
      return new Response(
        JSON.stringify({ ok: false, error: "Session verification failed" }),
        { status: 502, headers }
      );
    }

    const sessions = await sessionResponse.json();
    const session = Array.isArray(sessions) ? sessions[0] : null;

    if (!session) {
      return new Response(
        JSON.stringify({ ok: true, authenticated: false }),
        {
          status: 200,
          headers: {
            ...headers,
            "Set-Cookie":
              "panepan_streamer_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
          },
        }
      );
    }

    const accountUrl = new URL(`${baseUrl}/rest/v1/streamer_accounts`);
    accountUrl.searchParams.set("select", "id,login_id,is_active");
    accountUrl.searchParams.set("id", `eq.${session.streamer_id}`);
    accountUrl.searchParams.set("limit", "1");

    const accountResponse = await fetch(accountUrl.toString(), {
      headers: {
        apikey: env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      },
    });

    if (!accountResponse.ok) {
      return new Response(
        JSON.stringify({ ok: false, error: "Account verification failed" }),
        { status: 502, headers }
      );
    }

    const accounts = await accountResponse.json();
    const account = Array.isArray(accounts) ? accounts[0] : null;

    if (!account || account.is_active !== true) {
      return new Response(
        JSON.stringify({ ok: true, authenticated: false }),
        {
          status: 200,
          headers: {
            ...headers,
            "Set-Cookie":
              "panepan_streamer_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
          },
        }
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        authenticated: true,
        streamer: { id: account.id, loginId: account.login_id },
      }),
      { status: 200, headers }
    );
  } catch {
    return new Response(
      JSON.stringify({ ok: false, error: "Session check failed" }),
      { status: 400, headers }
    );
  }
}
