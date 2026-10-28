
export async function onRequest({ request, env }) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };

  if (request.method !== "GET") {
    return new Response(
      JSON.stringify({ ok: false, error: "GET method required" }),
      {
        status: 405,
        headers: { ...headers, Allow: "GET" },
      }
    );
  }

  const cookieHeader = request.headers.get("Cookie") || "";
  const tokenMatch = cookieHeader.match(
    /(?:^|;\s*)panepan_session=([^;]+)/
  );

  if (!tokenMatch) {
    return new Response(
      JSON.stringify({ ok: true, authenticated: false }),
      { status: 200, headers }
    );
  }

  if (
    !env.SUPABASE_URL ||
    !env.SUPABASE_PUBLISHABLE_KEY ||
    !env.SUPABASE_SECRET_KEY
  ) {
    return new Response(
      JSON.stringify({ ok: false, error: "Server configuration error" }),
      { status: 500, headers }
    );
  }

  const token = decodeURIComponent(tokenMatch[1]);
  const supabaseUrl = env.SUPABASE_URL.replace(/\/+$/, "");

  try {
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: env.SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`,
      },
    });

    if (!userResponse.ok) {
      return new Response(
        JSON.stringify({ ok: true, authenticated: false }),
        {
          status: 200,
          headers: {
            ...headers,
            "Set-Cookie": "panepan_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
          },
        }
      );
    }

    const user = await userResponse.json();

    const adminUrl = new URL(`${supabaseUrl}/rest/v1/admin_users`);
    adminUrl.searchParams.set("select", "user_id");
    adminUrl.searchParams.set("user_id", `eq.${user.id}`);
    adminUrl.searchParams.set("limit", "1");

    const adminResponse = await fetch(adminUrl.toString(), {
      headers: {
        apikey: env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      },
    });

    if (!adminResponse.ok) {
      return new Response(
        JSON.stringify({ ok: false, error: "Admin verification failed" }),
        { status: 500, headers }
      );
    }

    const admins = await adminResponse.json();
    const isAdmin = Array.isArray(admins) && admins.length === 1;

    if (!isAdmin) {
      return new Response(
        JSON.stringify({ ok: true, authenticated: false }),
        {
          status: 200,
          headers: {
            ...headers,
            "Set-Cookie": "panepan_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
          },
        }
      );
    }

    return new Response(
      JSON.stringify({ ok: true, authenticated: true }),
      { status: 200, headers }
    );
  } catch {
    return new Response(
      JSON.stringify({ ok: false, error: "Session check unavailable" }),
      { status: 502, headers }
    );
  }
}
