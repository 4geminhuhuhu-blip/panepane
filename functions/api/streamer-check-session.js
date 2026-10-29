
export async function onRequestGet({ request, env }) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };

  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers });

  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(
    /(?:^|;\s*)panepan_streamer_session=([^;]*)/
  );
  const token = match ? decodeURIComponent(match[1]) : "";

  // Cookieがない場合は未ログイン
  if (!token) {
    return json({ ok: true, authenticated: false });
  }

  // セッショントークンの形式を確認
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    return json({ ok: true, authenticated: false });
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    return json(
      { ok: false, error: "Server configuration error" },
      500
    );
  }

  try {
    // CookieのトークンをSHA-256でハッシュ化
    const bytes = new TextEncoder().encode(token);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const tokenHash = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Supabaseでセッションを検索
    const url = new URL(
      "/rest/v1/streamer_sessions",
      env.SUPABASE_URL
    );
    url.searchParams.set("select", "streamer_id,expires_at");
    url.searchParams.set("token_hash", `eq.${tokenHash}`);
    url.searchParams.set("limit", "1");

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        apikey: env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      },
    });

    if (!response.ok) {
      return json(
        { ok: false, error: "Session check failed" },
        502
      );
    }

    const sessions = await response.json();
    const session = sessions[0];

    // セッションが存在しない、または期限切れ
    if (
      !session ||
      !session.expires_at ||
      new Date(session.expires_at).getTime() <= Date.now()
    ) {
      return json({ ok: true, authenticated: false });
    }

    // 有効なログインセッション
    return json({
      ok: true,
      authenticated: true,
      streamer_id: session.streamer_id,
    });
  } catch {
    return json(
      { ok: false, error: "Session check failed" },
      500
    );
  }
}
