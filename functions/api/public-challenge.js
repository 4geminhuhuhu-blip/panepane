
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET") {
    return json({ ok: false, error: "GET method required" }, 405);
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    return json({ ok: false, error: "Server configuration error" }, 500);
  }

  const url = new URL(request.url);
  const streamerId = url.searchParams.get("id");

  if (!streamerId || streamerId.length > 100) {
    return json({ ok: false, error: "配信者IDが指定されていません。" }, 400);
  }

  const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");
  const headers = {
    apikey: env.SUPABASE_SECRET_KEY,
  };

  try {
    // 配信者IDに対応するチャレンジを取得
    const challengeUrl = new URL(`${baseUrl}/rest/v1/challenges`);
    challengeUrl.searchParams.set(
      "select",
      "id,streamer_id,title,grid_rows,grid_columns,image_url,image_position_x,image_position_y,image_scale,is_started,"
    );
    challengeUrl.searchParams.set("streamer_id", `eq.${streamerId}`);
    challengeUrl.searchParams.set("limit", "1");

    const challengeResponse = await fetch(challengeUrl, { headers });

　if (!challengeResponse.ok) {
  const errorText = await challengeResponse.text();
  console.error(
    "Public challenge query failed:",
    challengeResponse.status,
    errorText
  );

  return json(
    { ok: false, error: "チャレンジ情報を取得できませんでした。" },
    502
  );
}

    const challengeList = await challengeResponse.json();
    const record = Array.isArray(challengeList) ? challengeList[0] : null;

    if (!record) {
      return json({ ok: false, error: "チャレンジが見つかりません。" }, 404);
    }

    // パネルを取得
    const panelsUrl = new URL(`${baseUrl}/rest/v1/challenge_panels`);
    panelsUrl.searchParams.set("select", "*");
    panelsUrl.searchParams.set("challenge_id", `eq.${record.id}`);

    const panelsResponse = await fetch(panelsUrl, { headers });

    if (!panelsResponse.ok) {
      console.error("Public panels query failed:", panelsResponse.status);
      return json({ ok: false, error: "パネル情報を取得できませんでした。" }, 502);
    }

    const panelRecords = await panelsResponse.json();

    // 公開してよい項目だけを返す
    const panels = panelRecords.map((panel) => ({
      condition: typeof panel.condition === "string" ? panel.condition : "",
      is_open: panel.is_open === true,
      panel_index:
        Number.isInteger(panel.panel_index) ? panel.panel_index : null,
    }));

    panels.sort((a, b) => {
      if (a.panel_index === null || b.panel_index === null) return 0;
      return a.panel_index - b.panel_index;
    });

    const challenge = {
      title: record.title,
      grid_rows: record.grid_rows,
      grid_columns: record.grid_columns,
      image_url: record.image_url,
      image_position_x: record.image_position_x,
      image_position_y: record.image_position_y,
      image_scale: record.image_scale,
      is_started: record.is_started,
     
    };

    return json({ ok: true, challenge, panels });
  } catch (error) {
    console.error("Public challenge error:", error);
    return json({ ok: false, error: "読み込み中にエラーが発生しました。" }, 500);
  }
}
