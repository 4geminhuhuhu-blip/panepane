
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function getStreamerId(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(
    /(?:^|;\s*)panepan_streamer_session=([^;]*)/
  );

  let token = "";

  try {
    token = match ? decodeURIComponent(match[1]) : "";
  } catch {
    return null;
  }

  if (!/^[a-f0-9]{64}$/i.test(token)) return null;

  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const tokenHash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const url = new URL(
    "/rest/v1/streamer_sessions",
    env.SUPABASE_URL
  );
  url.searchParams.set("select", "streamer_id,expires_at");
  url.searchParams.set("token_hash", `eq.${tokenHash}`);
  url.searchParams.set("limit", "1");

  const response = await fetch(url.toString(), {
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
    },
  });

  if (!response.ok) throw new Error("Session lookup failed");

  const sessions = await response.json();
  const session = sessions[0];

  if (
    !session ||
    !session.expires_at ||
    new Date(session.expires_at).getTime() <= Date.now()
  ) {
    return null;
  }

  return session.streamer_id;
}

function supabaseUrl(env, table) {
  return new URL(
    `/rest/v1/${table}`,
    env.SUPABASE_URL.replace(/\/+$/, "")
  );
}

function supabaseHeaders(env, extra = {}) {
  return {
    apikey: env.SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function getChallenge(streamerId, env) {
  const url = supabaseUrl(env, "challenges");
  url.searchParams.set("select", "*");
  url.searchParams.set("streamer_id", `eq.${streamerId}`);
  url.searchParams.set("limit", "1");

  const response = await fetch(url, {
    headers: supabaseHeaders(env),
  });

  if (!response.ok) throw new Error("Could not load challenge");

  const rows = await response.json();
  return rows[0] || null;
}

async function getPanels(challengeId, env) {
  const url = supabaseUrl(env, "challenge_panels");
  url.searchParams.set("select", "*");
  url.searchParams.set("challenge_id", `eq.${challengeId}`);
  url.searchParams.set("order", "panel_number.asc");

  const response = await fetch(url, {
    headers: supabaseHeaders(env),
  });

  if (!response.ok) throw new Error("Could not load panels");

  return response.json();
}

async function saveChallenge(request, env, streamerId) {
  let body;

  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const title =
    typeof body.title === "string"
      ? body.title.trim()
      : "立ち絵チャレンジ";

  const rows = body.grid_rows;
  const columns = body.grid_columns;

  if (
    !Number.isInteger(rows) ||
    !Number.isInteger(columns) ||
    rows < 3 ||
    rows > 10 ||
    columns < 3 ||
    columns > 10
  ) {
    return json({
      ok: false,
      error: "縦横のパネル数は3〜10で指定してください",
    }, 400);
  }

  if (!title || title.length > 100) {
    return json({
      ok: false,
      error: "タイトルは1〜100文字で指定してください",
    }, 400);
  }

  const panelCount = rows * columns;
  const conditions = body.panels;

  if (
    !Array.isArray(conditions) ||
    conditions.length !== panelCount
  ) {
    return json({
      ok: false,
      error: `パネル条件は${panelCount}個必要です`,
    }, 400);
  }

  const conditionMap = new Map();

  for (const panel of conditions) {
    if (
      !panel ||
      !Number.isInteger(panel.panel_number) ||
      panel.panel_number < 1 ||
      panel.panel_number > panelCount ||
      typeof panel.condition_text !== "string" ||
      panel.condition_text.length > 500
    ) {
      return json({
        ok: false,
        error: "パネル番号または条件文が正しくありません",
      }, 400);
    }

    if (conditionMap.has(panel.panel_number)) {
      return json({
        ok: false,
        error: "パネル番号が重複しています",
      }, 400);
    }

    conditionMap.set(
      panel.panel_number,
      panel.condition_text.trim()
    );
  }

  for (let number = 1; number <= panelCount; number++) {
    if (!conditionMap.has(number)) {
      return json({
        ok: false,
        error: `パネル${number}の条件がありません`,
      }, 400);
    }
  }

  const existing = await getChallenge(streamerId, env);

  if (
    existing &&
    existing.is_started &&
    (existing.grid_rows !== rows ||
      existing.grid_columns !== columns)
  ) {
    return json({
      ok: false,
      error: "開始済みのチャレンジはパネル数を変更できません",
    }, 409);
  }

  const now = new Date().toISOString();

  let challenge = existing;

  if (!challenge) {
    const url = supabaseUrl(env, "challenges");

    const response = await fetch(url, {
      method: "POST",
      headers: supabaseHeaders(env, {
        Prefer: "return=representation",
      }),
      body: JSON.stringify({
        streamer_id: streamerId,
        title,
        grid_rows: rows,
        grid_columns: columns,
        updated_at: now,
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("Challenge creation failed:", response.status, detail);
      return json({
        ok: false,
        error: "チャレンジを作成できませんでした",
      }, 502);
    }

    const created = await response.json();
    challenge = created[0];

    if (!challenge) {
      return json({
        ok: false,
        error: "作成結果を取得できませんでした",
      }, 502);
    }
  } else {
    const url = supabaseUrl(env, "challenges");
    url.searchParams.set("id", `eq.${challenge.id}`);
    url.searchParams.set("streamer_id", `eq.${streamerId}`);

    const response = await fetch(url, {
      method: "PATCH",
      headers: supabaseHeaders(env, {
        Prefer: "return=representation",
      }),
      body: JSON.stringify({
        title,
        grid_rows: rows,
        grid_columns: columns,
        updated_at: now,
      }),
    });

    if (!response.ok) {
      console.error(
        "Challenge update failed:",
        response.status,
        await response.text()
      );
      return json({
        ok: false,
        error: "チャレンジを保存できませんでした",
      }, 502);
    }

    const updated = await response.json();
    challenge = updated[0] || challenge;
  }

  const currentPanels = await getPanels(challenge.id, env);

  if (existing && !existing.is_started &&
      (existing.grid_rows !== rows ||
       existing.grid_columns !== columns)) {
    const deleteUrl = supabaseUrl(env, "challenge_panels");
    deleteUrl.searchParams.set("challenge_id", `eq.${challenge.id}`);

    const deleteResponse = await fetch(deleteUrl, {
      method: "DELETE",
      headers: supabaseHeaders(env),
    });

    if (!deleteResponse.ok) {
      return json({
        ok: false,
        error: "パネル構成を更新できませんでした",
      }, 502);
    }
  }

  const panelsToSave = [];

  for (let number = 1; number <= panelCount; number++) {
    const oldPanel = currentPanels.find(
      (panel) => panel.panel_number === number
    );

    if (oldPanel?.is_open) {
      panelsToSave.push({
        id: oldPanel.id,
        challenge_id: challenge.id,
        panel_number: number,
        condition_text: conditionMap.get(number),
        is_open: true,
        opened_at: oldPanel.opened_at,
        updated_at: now,
      });
    } else {
      panelsToSave.push({
        challenge_id: challenge.id,
        panel_number: number,
        condition_text: conditionMap.get(number),
        is_open: false,
        updated_at: now,
      });
    }
  }

  const panelsUrl = supabaseUrl(env, "challenge_panels");

  if (existing && existing.is_started) {
    for (const panel of panelsToSave) {
      const url = supabaseUrl(env, "challenge_panels");
      url.searchParams.set("challenge_id", `eq.${challenge.id}`);
      url.searchParams.set("panel_number", `eq.${panel.panel_number}`);

      const response = await fetch(url, {
        method: "PATCH",
        headers: supabaseHeaders(env),
        body: JSON.stringify({
          condition_text: panel.condition_text,
          updated_at: now,
        }),
      });

      if (!response.ok) {
        return json({
          ok: false,
          error: "パネル条件を保存できませんでした",
        }, 502);
      }
    }
  } else if (panelsToSave.length > 0) {
    const response = await fetch(panelsUrl, {
      method: "POST",
      headers: supabaseHeaders(env, {
        Prefer: "resolution=merge-duplicates,return=minimal",
      }),
      body: JSON.stringify(panelsToSave),
    });

    if (!response.ok) {
      console.error(
        "Panel save failed:",
        response.status,
        await response.text()
      );
      return json({
        ok: false,
        error: "パネル条件を保存できませんでした",
      }, 502);
    }
  }

  const savedPanels = await getPanels(challenge.id, env);

  return json({
    ok: true,
    challenge,
    panels: savedPanels,
  });
}

export async function onRequest({ request, env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    return json({ ok: false, error: "Server configuration error" }, 500);
  }

  try {
    const streamerId = await getStreamerId(request, env);

    if (!streamerId) {
      return json({ ok: false, error: "Not authenticated" }, 401);
    }

    if (request.method === "GET") {
      const challenge = await getChallenge(streamerId, env);

      if (!challenge) {
        return json({ ok: true, challenge: null, panels: [] });
      }

      const panels = await getPanels(challenge.id, env);
      return json({ ok: true, challenge, panels });
    }

    if (request.method === "POST") {
      return await saveChallenge(request, env, streamerId);
    }

    return json({
      ok: false,
      error: "GET or POST method required",
    }, 405);
  } catch (error) {
    console.error("Challenge API error:", error);
    return json({ ok: false, error: "Internal server error" }, 500);
  }
}
