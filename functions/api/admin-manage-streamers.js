
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

// 管理者本人の認証と権限確認
async function requireAdmin(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)panepan_session=([^;]+)/);

  if (!match) {
    return {
      error: json({ ok: false, error: "管理者ログインが必要です。" }, 401),
    };
  }

  let token;
  try {
    token = decodeURIComponent(match[1]);
  } catch {
    return {
      error: json({ ok: false, error: "セッションが無効です。" }, 401),
    };
  }

  const base = env.SUPABASE_URL.replace(/\/+$/, "");

  const userRes = await fetch(`${base}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
  });

  if (!userRes.ok) {
    return {
      error: json({
        ok: false,
        error: "管理者ログインの有効期限が切れています。",
      }, 401),
    };
  }

  const user = await userRes.json();

  if (!user?.id) {
    return {
      error: json({ ok: false, error: "ユーザーを確認できません。" }, 401),
    };
  }

  const adminUrl = new URL(`${base}/rest/v1/admin_users`);
  adminUrl.searchParams.set("select", "user_id");
  adminUrl.searchParams.set("user_id", `eq.${user.id}`);
  adminUrl.searchParams.set("limit", "1");

  const adminRes = await fetch(adminUrl.toString(), {
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
  });

  if (!adminRes.ok) {
    const detail = await adminRes.text();
    console.error("Admin role lookup failed:", adminRes.status, detail);

    return {
      error: json({
        ok: false,
        error: "管理者権限を確認できませんでした。",
        diagnosticStatus: adminRes.status,
      }, 502),
    };
  }

  const admins = await adminRes.json();

  if (!Array.isArray(admins) || admins.length !== 1) {
    return {
      error: json({ ok: false, error: "管理者権限がありません。" }, 403),
    };
  }

  return { user, base };
}

// サーバー側のデータ操作用ヘッダー
function headers(env, extra = {}) {
  return {
    apikey: env.SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
    ...extra,
  };
}

async function rest(env, path, options = {}) {
  return fetch(
    `${env.SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/${path}`,
    {
      ...options,
      headers: headers(env, {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      }),
      cache: "no-store",
    }
  );
}

// DELETEした件数を確認する
async function deleteAndCount(env, path, label) {
  const response = await rest(env, path, {
    method: "DELETE",
    headers: {
      Prefer: "return=representation",
    },
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `${label} delete failed: ${response.status} ${responseText}`
    );
  }

  let deletedRows = [];

  if (responseText.trim()) {
    try {
      deletedRows = JSON.parse(responseText);
    } catch {
      throw new Error(`${label} delete response could not be parsed.`);
    }
  }

  if (!Array.isArray(deletedRows)) {
    throw new Error(`${label} delete response was not an array.`);
  }

  return deletedRows.length;
}

// Storage内の配信者画像を取得
async function listStorageObjects(env, prefix) {
  const response = await fetch(
    `${env.SUPABASE_URL.replace(/\/+$/, "")}/storage/v1/object/list/challenge-images`,
    {
      method: "POST",
      headers: headers(env, {
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        prefix,
        limit: 1000,
        offset: 0,
        sortBy: {
          column: "name",
          order: "asc",
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Storage list failed: ${response.status} ${await response.text()}`
    );
  }

  const items = await response.json();

  return (Array.isArray(items) ? items : [])
    .filter((item) => item && item.name)
    .map((item) => `${prefix}/${item.name}`);
}

// Storage内の画像を削除
async function removeStorageObjects(env, paths) {
  for (let i = 0; i < paths.length; i += 100) {
    const response = await fetch(
      `${env.SUPABASE_URL.replace(/\/+$/, "")}/storage/v1/object/challenge-images`,
      {
        method: "DELETE",
        headers: headers(env, {
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          prefixes: paths.slice(i, i + 100),
        }),
      }
    );

    if (!response.ok) {
      throw new Error(
        `Storage delete failed: ${response.status} ${await response.text()}`
      );
    }
  }
}

export async function onRequest({ request, env }) {
  if (!["GET", "DELETE"].includes(request.method)) {
    return json(
      {
        ok: false,
        error: "GETまたはDELETEで呼び出してください。",
      },
      405,
      { Allow: "GET, DELETE" }
    );
  }

  if (
    !env.SUPABASE_URL ||
    !env.SUPABASE_PUBLISHABLE_KEY ||
    !env.SUPABASE_SECRET_KEY
  ) {
    return json({
      ok: false,
      error: "Supabaseの環境変数が不足しています。",
    }, 500);
  }

  try {
    const auth = await requireAdmin(request, env);

    if (auth.error) {
      return auth.error;
    }

    // 配信者一覧取得
    if (request.method === "GET") {
      const [accountsRes, challengesRes] = await Promise.all([
        rest(env, "streamer_accounts?select=id,login_id,is_active"),
        rest(env, "challenges?select=id,streamer_id,title,is_started,is_ended"),
      ]);

      if (!accountsRes.ok) {
        const detail = await accountsRes.text();
        console.error("Streamer list failed:", accountsRes.status, detail);

        return json({
          ok: false,
          error: "配信者一覧を取得できませんでした。",
          diagnosticStatus: accountsRes.status,
        }, 502);
      }

      if (!challengesRes.ok) {
        const detail = await challengesRes.text();
        console.error("Challenge list failed:", challengesRes.status, detail);

        return json({
          ok: false,
          error: "チャレンジ一覧を取得できませんでした。",
          diagnosticStatus: challengesRes.status,
        }, 502);
      }

      const accounts = await accountsRes.json();
      const challenges = await challengesRes.json();

      const challengeMap = new Map();

      for (const challenge of challenges) {
        challengeMap.set(String(challenge.streamer_id), challenge);
      }

      return json({
        ok: true,
        streamers: accounts.map((account) => {
          const challenge = challengeMap.get(String(account.id));

          return {
            id: account.id,
            login_id: account.login_id,
            is_active: account.is_active === true,
            challenge_title: challenge?.title || "",
            challenge_status: !challenge
              ? "未作成"
              : challenge.is_ended
                ? "終了"
                : challenge.is_started
                  ? "開催中"
                  : "準備中",
          };
        }),
      });
    }

    // 削除リクエスト
    let body;

    try {
      body = await request.json();
    } catch {
      return json({
        ok: false,
        error: "リクエスト内容を読み取れません。",
      }, 400);
    }

    const streamerId =
      typeof body.streamer_id === "string"
        ? body.streamer_id.trim()
        : "";

    const confirmLoginId =
      typeof body.confirm_login_id === "string"
        ? body.confirm_login_id.trim()
        : "";

    if (!streamerId || streamerId.length > 100 || !confirmLoginId) {
      return json({
        ok: false,
        error: "削除対象の指定が正しくありません。",
      }, 400);
    }

    // 対象アカウントの確認
    const accountRes = await rest(
      env,
      `streamer_accounts?select=id,login_id&id=eq.${encodeURIComponent(streamerId)}&limit=1`
    );

    if (!accountRes.ok) {
      const detail = await accountRes.text();
      console.error("Target account lookup failed:", accountRes.status, detail);

      return json({
        ok: false,
        error: "対象アカウントを確認できませんでした。",
        diagnosticStatus: accountRes.status,
      }, 502);
    }

    const accountRows = await accountRes.json();
    const account = accountRows[0];

    if (!account) {
      return json({
        ok: false,
        error: "対象アカウントは既に存在しません。",
      }, 404);
    }

    if (account.login_id !== confirmLoginId) {
      return json({
        ok: false,
        error: "確認用ログインIDが一致しません。",
      }, 400);
    }

    // 関連チャレンジの取得
    const challengeRes = await rest(
      env,
      `challenges?select=id&streamer_id=eq.${encodeURIComponent(streamerId)}`
    );

    if (!challengeRes.ok) {
      const detail = await challengeRes.text();
      console.error("Challenge lookup failed:", challengeRes.status, detail);

      return json({
        ok: false,
        error: "関連チャレンジを確認できませんでした。",
        diagnosticStatus: challengeRes.status,
      }, 502);
    }

    const challenges = await challengeRes.json();

    // Storage内の立ち絵画像を削除
    const storagePaths = await listStorageObjects(env, streamerId);

    if (storagePaths.length) {
      await removeStorageObjects(env, storagePaths);
    }

    // パネル情報を削除
    let deletedPanels = 0;

    for (const challenge of challenges) {
      deletedPanels += await deleteAndCount(
        env,
        `challenge_panels?challenge_id=eq.${encodeURIComponent(challenge.id)}`,
        "Panel"
      );
    }

    // チャレンジ本体を削除
    const deletedChallenges = await deleteAndCount(
      env,
      `challenges?streamer_id=eq.${encodeURIComponent(streamerId)}`,
      "Challenge"
    );

    // ログインセッションを削除
    const deletedSessions = await deleteAndCount(
      env,
      `streamer_sessions?streamer_id=eq.${encodeURIComponent(streamerId)}`,
      "Session"
    );

    // 配信者アカウント本体を削除し、削除件数を確認
    const deletedAccounts = await deleteAndCount(
      env,
      `streamer_accounts?id=eq.${encodeURIComponent(streamerId)}&login_id=eq.${encodeURIComponent(confirmLoginId)}`,
      "Streamer account"
    );

    if (deletedAccounts !== 1) {
      console.error("Streamer account was not deleted:", {
        streamerId,
        loginId: confirmLoginId,
        deletedAccounts,
      });

      return json({
        ok: false,
        error: `関連データの削除処理は進みましたが、配信者アカウント本体を削除できませんでした。削除件数：${deletedAccounts}件`,
        diagnostic: "STREAMER_ACCOUNT_DELETE_COUNT_MISMATCH",
      }, 500);
    }

    // 削除後にアカウントが残っていないか再確認
    const verifyRes = await rest(
      env,
      `streamer_accounts?select=id&id=eq.${encodeURIComponent(streamerId)}&limit=1`
    );

    if (!verifyRes.ok) {
      throw new Error(
        `Account verification failed: ${verifyRes.status} ${await verifyRes.text()}`
      );
    }

    const remainingAccounts = await verifyRes.json();

    if (remainingAccounts.length > 0) {
      throw new Error("Streamer account still exists after delete.");
    }

    return json({
      ok: true,
      message: `${account.login_id} と関連データを削除しました。`,
      deleted: {
        accounts: deletedAccounts,
        challenges: deletedChallenges,
        panels: deletedPanels,
        sessions: deletedSessions,
        images: storagePaths.length,
      },
    });

  } catch (error) {
    console.error("Admin streamer management error:", error);

    return json({
      ok: false,
      error: "削除または一覧取得に失敗しました。サーバーログを確認してください。",
    }, 500);
  }
}
