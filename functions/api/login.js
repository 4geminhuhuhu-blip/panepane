
export async function onRequest({ request, env }) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };

  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "POST method required" }),
      { status: 405, headers: { ...headers, Allow: "POST" } }
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

  let body;

  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ ok: false, error: "Invalid request" }),
      { status: 400, headers }
    );
  }

  const email =
    typeof body.email === "string" ? body.email.trim() : "";
  const password =
    typeof body.password === "string" ? body.password : "";

  if (!email || !password || email.length > 320 || password.length > 1024) {
    return new Response(
      JSON.stringify({ ok: false, error: "Email and password are required" }),
      { status: 400, headers }
    );
  }

  const supabaseUrl = env.SUPABASE_URL.replace(/\/+$/, "");

  try {
    const authResponse = await fetch(
      `${supabaseUrl}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: env.SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({ email, password }),
      }
    );

    if (!authResponse.ok) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Invalid credentials or not an admin",
        }),
        { status: 401, headers }
      );
    }

    const authData = await authResponse.json();
    const userId = authData.user?.id;
    const accessToken = authData.access_token;
    const expiresIn = Number(authData.expires_in);

    if (
      !userId ||
      typeof accessToken !== "string" ||
      !Number.isFinite(expiresIn) ||
      expiresIn <= 0
    ) {
      return new Response(
        JSON.stringify({ ok: false, error: "Authentication failed" }),
        { status: 401, headers }
      );
    }

    const adminUrl = new URL(`${supabaseUrl}/rest/v1/admin_users`);
    adminUrl.searchParams.set("select", "user_id");
    adminUrl.searchParams.set("user_id", `eq.${userId}`);
    adminUrl.searchParams.set("limit", "1");

    const adminResponse = await fetch(adminUrl.toString(), {
      headers: {
        apikey: env.SUPABASE_SECRET_KEY,
      },
    });

    if (!adminResponse.ok) {
      return new Response(
        JSON.stringify({ ok: false, error: "Admin verification failed" }),
        { status: 500, headers }
      );
    }

    const admins = await adminResponse.json();

    if (!Array.isArray(admins) || admins.length !== 1) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Invalid credentials or not an admin",
        }),
        { status: 403, headers }
      );
    }

    const cookie = [
      `panepan_session=${encodeURIComponent(accessToken)}`,
      "Path=/",
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      `Max-Age=${Math.min(Math.floor(expiresIn), 3600)}`,
    ].join("; ");

    return new Response(
      JSON.stringify({ ok: true, message: "Admin verified" }),
      {
        status: 200,
        headers: { ...headers, "Set-Cookie": cookie },
      }
    );
  } catch {
    return new Response(
      JSON.stringify({ ok: false, error: "Login service unavailable" }),
      { status: 502, headers }
    );
  }
}
