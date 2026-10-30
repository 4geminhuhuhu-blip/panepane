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

function headers(env, extra = {}) {
  return {
    apikey: env.SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
    ...extra,
  };
}

async function requireAdmin(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)panepan_session=([^;]+)/);
  if (!match) return { error: json({ ok: false, error: "管理者ログインが必要です。" }, 401) };

  let token;
  try { token = decodeURIComponent(match[1]); }
  catch { return { error: json({ ok: false, error: "セッションが無効です。" }, 401) }; }

  const base = env.SUPABASE_URL.replace(/\/+$/, "");
  const userRes = await fetch(`${base}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!userRes.ok) return { error: json({ ok: false, error: "管理者ログインの有効期限が切れています。" }, 401) };
  const user = await userRes.json();
  if (!user?.id) return { error: json({ ok: false, error: "ユーザーを確認できません。" }, 401) };

  const url = new URL(`${base}/rest/v1/admin_users`);
  url.searchParams.set("select", "user_id");
  url.searchParams.set("user_id", `eq.${user.id}`);
  url.searchParams.set("limit", "1");
  const adminRes = await fetch(url, { headers: headers(env), cache: "no-store" });
  if (!adminRes.ok) throw new Error("Admin role lookup failed");
  const admins = await adminRes.json();
  if (!Array.isArray(admins) || admins.length !== 1) {
    return { error: json({ ok: false, error: "管理者権限がありません。" }, 403) };
  }
  return { user, base };
}

async function rest(env, path, options = {}) {
  const response = await fetch(`${env.SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/${path}`, {
    ...options,
    headers: headers(env, {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    }),
    cache: "no-store",
  });
  return response;
}

async function listStorageObjects(env, prefix) {
  const response = await fetch(`${env.SUPABASE_URL.replace(/\/+$/, "")}/storage/v1/object/list/challenge-images`, {
    method: "POST",
    headers: headers(env, { "Content-Type": "application/json" }),
    body: JSON.stringify({ prefix, limit: 1000, offset: 0, sortBy: { column: "name", order: "asc" } }),
  });
  if (!response.ok) throw new Error(`Storage list failed: ${response.status}`);
  const items = await response.json();
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && item.name && item.id)
    .map((item) => `${prefix}/${item.name}`);
}

async function removeStorageObjects(env, paths) {
  for (let i = 0; i < paths.length; i += 100) {
    const response = await fetch(`${env.SUPABASE_URL.replace(/\/+$/, "")}/storage/v1/object/challenge-images`, {
      method: "DELETE",
      headers: headers(env, { "Content-Type": "application/json" }),
      body: JSON.stringify({ prefixes: paths.slice(i, i + 100) }),
    });
    if (!response.ok) throw new Error(`Storage delete failed: ${response.status}`);
  }
}

export async function onRequest({ request, env }) {
  if (!["GET", "DELETE"].includes(request.method)) {
    return json({ ok: false, error: "GETまたはDELETEで呼び出してください。" }, 405, { Allow: "GET, DELETE" });
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    return json({ ok: false, error: "サーバー設定が不足しています。" }, 500);
  }
  try {
    const auth = await requireAdmin(request, env);
    if (auth.error) return auth.error;
    const base = auth.base;

    if (request.method === "GET") {
      const [accountsRes, challengesRes] = await Promise.all([
        rest(env, "streamer_accounts?select=id,login_id,is_active&order=created_at.desc"),
        rest(env, "challenges?select=id,streamer_id,title,is_started,is_ended"),
      ]);
      if (!accountsRes.ok || !challengesRes.ok) {
        console.error("Admin streamer list failed", await accountsRes.text(), await challengesRes.text());
        return json({ ok: false, error: "配信者一覧を取得できませんでした。" }, 502);
      }
      const accounts = await accountsRes.json();
      const challenges = await challengesRes.json();
      const challengeMap = new Map();
      for (const c of challenges) challengeMap.set(c.streamer_id, c);
      return json({
        ok: true,
        streamers: accounts.map((a) => {
          const c = challengeMap.get(a.id);
          return {
            id: a.id,
            login_id: a.login_id,
            is_active: a.is_active === true,
            
            challenge_title: c?.title || "",
            challenge_status: !c ? "未作成" : c.is_ended ? "終了" : c.is_started ? "開催中" : "準備中",
          };
        }),
      });
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ ok: false, error: "リクエスト内容を読み取れません。" }, 400); }

    const streamerId = typeof body.streamer_id === "string" ? body.streamer_id.trim() : "";
    const confirmLoginId = typeof body.confirm_login_id === "string" ? body.confirm_login_id.trim() : "";
    if (!streamerId || streamerId.length > 100 || !confirmLoginId) {
      return json({ ok: false, error: "削除対象の指定が正しくありません。" }, 400);
    }

    const accountRes = await rest(env, `streamer_accounts?select=id,login_id&id=eq.${encodeURIComponent(streamerId)}&limit=1`);
    if (!accountRes.ok) return json({ ok: false, error: "対象アカウントを確認できません。" }, 502);
    const accountRows = await accountRes.json();
    const account = accountRows[0];
    if (!account) return json({ ok: false, error: "対象アカウントは既に存在しません。" }, 404);
    if (account.login_id !== confirmLoginId) return json({ ok: false, error: "確認用ログインIDが一致しません。" }, 400);

    const challengeRes = await rest(env, `challenges?select=id,image_url&streamer_id=eq.${encodeURIComponent(streamerId)}`);
    if (!challengeRes.ok) return json({ ok: false, error: "関連チャレンジを確認できません。" }, 502);
    const challenges = await challengeRes.json();
    const challengeIds = challenges.map((c) => c.id).filter(Boolean);

    // Storage objects are stored under <streamer_id>/... .
    const storagePaths = await listStorageObjects(env, streamerId);
    if (storagePaths.length) await removeStorageObjects(env, storagePaths);

    if (challengeIds.length) {
      const inList = `(${challengeIds.map((id) => `"${String(id).replace(/"/g, '\\"')}"`).join(",")})`;
      const panelDelete = await rest(env, `challenge_panels?challenge_id=in.${encodeURIComponent(inList)}`, { method: "DELETE" });
      if (!panelDelete.ok) throw new Error(`Panel delete failed: ${panelDelete.status} ${await panelDelete.text()}`);
    }

    const challengeDelete = await rest(env, `challenges?streamer_id=eq.${encodeURIComponent(streamerId)}`, { method: "DELETE" });
    if (!challengeDelete.ok) throw new Error(`Challenge delete failed: ${challengeDelete.status} ${await challengeDelete.text()}`);

    const sessionsDelete = await rest(env, `streamer_sessions?streamer_id=eq.${encodeURIComponent(streamerId)}`, { method: "DELETE" });
    if (!sessionsDelete.ok) throw new Error(`Session delete failed: ${sessionsDelete.status} ${await sessionsDelete.text()}`);

    const accountDelete = await rest(env, `streamer_accounts?id=eq.${encodeURIComponent(streamerId)}`, { method: "DELETE" });
    if (!accountDelete.ok) throw new Error(`Account delete failed: ${accountDelete.status} ${await accountDelete.text()}`);

    return json({ ok: true, message: `${account.login_id} と関連データを削除しました。` });
  } catch (error) {
    console.error("Admin streamer management error:", error);
    return json({ ok: false, error: "削除または一覧取得に失敗しました。サーバーログを確認してください。" }, 500);
  }
}
