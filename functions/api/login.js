
export async function onRequest({ request, env }) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };

  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "POST method required" }),
      {
        status: 405,
        headers: { ...headers, Allow: "POST" },
      }
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
    // 1. Supabase Authでメールアドレスとパスワードを検証
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
        JSON.stringify({ ok: false, error: "Invalid credentials or not an admin" }),
        { status: 401, headers }
      );
    }

    const authData = await authResponse.json();
    const userId = authData.user?.id;

    if (!userId) {
      return new Response(
        JSON.stringify({ ok: false, error: "Authentication failed" }),
        { status: 401, headers }
      );
    }

    // 2. サーバー側の秘密鍵で管理者登録を確認
    const adminUrl = new URL(`${supabaseUrl}/rest/v1/admin_users`);
    adminUrl.searchParams.set("select", "user_id");
    adminUrl.searchParams.set("user_id", `eq.${userId}`);
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

    if (!Array.isArray(admins) || admins.length !== 1) {
      return new Response(
        JSON.stringify({ ok: false, error: "Invalid credentials or not an admin" }),
        { status: 403, headers }
      );
    }

    // 認証と管理者登録の確認結果のみ返す。
    // この応答だけでは、永続的なログインセッションは作成されない。
    return new Response(
      JSON.stringify({ ok: true, message: "Admin verified" }),
      { status: 200, headers }
    );
  } catch {
    return new Response(
      JSON.stringify({ ok: false, error: "Login service unavailable" }),
      { status: 502, headers }
    );
  }
}
