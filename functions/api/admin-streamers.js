import { hashPassword } from "../lib/password.js";

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

  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    return new Response(
      JSON.stringify({ ok: false, error: "Server configuration error" }),
      { status: 500, headers }
    );
  }

  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(
    /(?:^|;\s*)panepan_session=([^;]+)/
  );

  if (!match) {
    return new Response(
      JSON.stringify({ ok: false, error: "Admin login required" }),
      { status: 401, headers }
    );
  }

  let token;
  try {
    token = decodeURIComponent(match[1]);
  } catch {
    return new Response(
      JSON.stringify({ ok: false, error: "Invalid session" }),
      { status: 401, headers }
    );
  }

  const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");

  try {
    const userResponse = await fetch(`${baseUrl}/auth/v1/user`, {
      headers: {
        apikey: env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${token}`,
      },
    });

    if (!userResponse.ok) {
      return new Response(
        JSON.stringify({ ok: false, error: "Admin login required" }),
        { status: 401, headers }
      );
    }

    const user = await userResponse.json();

    const adminUrl = new URL(`${baseUrl}/rest/v1/admin_users`);
    adminUrl.searchParams.set("select", "user_id");
    adminUrl.searchParams.set("user_id", `eq.${user.id}`);
    adminUrl.searchParams.set("limit", "1");

    const adminResponse = await fetch(adminUrl.toString(), {
      headers: {
        apikey: env.SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`,
      },
    });

    if (!adminResponse.ok) {
      return new Response(
        JSON.stringify({ ok: false, error: "Admin verification failed" }),
        { status: 502, headers }
      );
    }

    const admins = await adminResponse.json();

    if (!Array.isArray(admins) || admins.length !== 1) {
      return new Response(
        JSON.stringify({ ok: false, error: "Admin access denied" }),
        { status: 403, headers }
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

    const loginId =
      typeof body.login_id === "string" ? body.login_id.trim() : "";
    const password =
      typeof body.password === "string" ? body.password : "";

    if (!/^[A-Za-z0-9_-]{3,40}$/.test(loginId)) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Login ID must be 3-40 letters, numbers, _ or -",
        }),
        { status: 400, headers }
      );
    }

    if (password.length < 8 || password.length > 1024) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Password must be at least 8 characters",
        }),
        { status: 400, headers }
      );
    }

    const passwordData = await hashPassword(password);

  const insertResponse = await fetch(
  `${baseUrl}/rest/v1/streamer_accounts`,
  {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      login_id: loginId,
      password_hash: passwordData.password_hash,
      password_salt: passwordData.password_salt,
      is_active: true,
    }),
  }
);

    if (insertResponse.status === 409) {
      return new Response(
        JSON.stringify({ ok: false, error: "Login ID already exists" }),
        { status: 409, headers }
      );
    }

if (!insertResponse.ok) {
  const errorText = await insertResponse.text();

  console.error("Streamer insert failed:", {
    status: insertResponse.status,
    error: errorText,
  });

  return new Response(
    JSON.stringify({ ok: false, error: "Account creation failed" }),
    { status: 502, headers }
  );
}

    return new Response(
      JSON.stringify({ ok: true, login_id: loginId }),
      { status: 201, headers }
    );
  } catch (error) {
    console.error("Account creation error:", error);

    return new Response(
      JSON.stringify({
        ok: false,
        error: "Account creation service unavailable",
      }),
      { status: 502, headers }
    );
  }
}
