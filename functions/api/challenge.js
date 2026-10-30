
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

  if (!/^[a-f0-9]{64}$/i.test(token)) {
    return null;
  }

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

  const response = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
    },
  });

  if (!response.ok) {
    throw new Error("Session check failed");
  }

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

export async function onRequest({ request, env }) {
  if (!["GET", "POST", "PATCH"].includes(request.method)) {
    return json(
      { ok: false, error: "Method not allowed" },
      405
    );
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    return json(
      { ok: false, error: "Server configuration error" },
      500
    );
  }

  try {
    const streamerId = await getStreamerId(request, env);

    if (!streamerId) {
      return json(
        {
          ok: false,
          error:
            "ログインの有効期限が切れています。再ログインしてください。",
        },
        401
      );
    }

    const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");

    const headers = {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
    };

    // ログイン中の配信者のチャレンジ情報
    const challengeUrl = new URL(
      `${baseUrl}/rest/v1/challenges`
    );

    challengeUrl.searchParams.set(
      "select",
      "id,streamer_id,title,grid_rows,grid_columns,image_url,image_position_x,image_position_y,image_scale,is_started,is_ended"
    );

    challengeUrl.searchParams.set(
      "streamer_id",
      `eq.${streamerId}`
    );

    challengeUrl.searchParams.set("limit", "1");

    // ========================================
    // GET：チャレンジとパネル情報を取得
    // ========================================
    if (request.method === "GET") {
      const challengeResponse = await fetch(challengeUrl, {
        headers,
      });

      if (!challengeResponse.ok) {
        return json(
          {
            ok: false,
            error: "チャレンジ情報を取得できませんでした。",
          },
          502
        );
      }

      const list = await challengeResponse.json();
      const record = list[0];

      if (!record) {
        return json({
          ok: true,
          challenge: null,
          panels: [],
        });
      }

      const panelsUrl = new URL(
        `${baseUrl}/rest/v1/challenge_panels`
      );

      panelsUrl.searchParams.set(
        "select",
        "panel_number,condition_text,target_value,current_value,is_open"
      );

      panelsUrl.searchParams.set(
        "challenge_id",
        `eq.${record.id}`
      );

      panelsUrl.searchParams.set(
        "order",
        "panel_number.asc"
      );

      const panelsResponse = await fetch(panelsUrl, {
        headers,
      });

      if (!panelsResponse.ok) {
        return json(
          {
            ok: false,
            error: "パネル情報を取得できませんでした。",
          },
          502
        );
      }

      return json({
        ok: true,
        challenge: record,
        panels: await panelsResponse.json(),
      });
    }

    // ========================================
    // PATCH：チャレンジ開始・終了・パネル開閉
    // ========================================
    if (request.method === "PATCH") {
      let body;

      try {
        body = await request.json();
      } catch {
        return json(
          {
            ok: false,
            error: "リクエストの形式が正しくありません。",
          },
          400
        );
      }

      // チャレンジ情報を取得
      const currentResponse = await fetch(challengeUrl, {
        headers,
      });

      if (!currentResponse.ok) {
        return json(
          {
            ok: false,
            error: "チャレンジ情報を取得できませんでした。",
          },
          502
        );
      }

      const currentList = await currentResponse.json();
      const current = currentList[0];

      if (!current) {
        return json(
          {
            ok: false,
            error: "チャレンジが見つかりません。",
          },
          404
        );
      }

      // 終了済みチャレンジの操作を禁止
      if (current.is_ended === true) {
        return json(
          {
            ok: false,
            error: "このチャレンジは終了しています。再開できません。",
          },
          400
        );
      }

      // ----------------------------------------
      // チャレンジ開始
      // ----------------------------------------
      if (body.action === "start") {
        const startUrl = new URL(
          `${baseUrl}/rest/v1/challenges`
        );

        startUrl.searchParams.set("id", `eq.${current.id}`);
        startUrl.searchParams.set("streamer_id", `eq.${streamerId}`);
        startUrl.searchParams.set("is_ended", "eq.false");

        const response = await fetch(startUrl, {
          method: "PATCH",
          headers: {
            ...headers,
            Prefer: "return=representation",
          },
          body: JSON.stringify({
            is_started: true,
          }),
        });

        if (!response.ok) {
          return json(
            {
              ok: false,
              error: "チャレンジを開始できませんでした。",
            },
            502
          );
        }

        const updated = await response.json();

        if (!updated.length) {
          return json(
            {
              ok: false,
              error: "チャレンジを開始できませんでした。",
            },
            400
          );
        }

        return json({
          ok: true,
          message: "チャレンジを開始しました。",
        });
      }

      // ----------------------------------------
      // チャレンジ終了
      // ----------------------------------------
      if (body.action === "end") {
        if (!current.is_started) {
          return json(
            {
              ok: false,
              error: "開始前のチャレンジは終了できません。",
            },
            400
          );
        }

        const endUrl = new URL(
          `${baseUrl}/rest/v1/challenges`
        );

        endUrl.searchParams.set("id", `eq.${current.id}`);
        endUrl.searchParams.set("streamer_id", `eq.${streamerId}`);
        endUrl.searchParams.set("is_ended", "eq.false");

        const response = await fetch(endUrl, {
          method: "PATCH",
          headers: {
            ...headers,
            Prefer: "return=representation",
          },
          body: JSON.stringify({
            is_ended: true,
          }),
        });

        if (!response.ok) {
          return json(
            {
              ok: false,
              error: "チャレンジを終了できませんでした。",
            },
            502
          );
        }

        const updated = await response.json();

        if (!updated.length) {
          return json(
            {
              ok: false,
              error: "チャレンジはすでに終了している可能性があります。",
            },
            400
          );
        }

        return json({
          ok: true,
          message: "チャレンジを終了しました。",
        });
      }

      // ----------------------------------------
      // パネルの開閉
      // ----------------------------------------
      if (body.action === "set-panel") {
        const panelNumber = Number(body.panel_number);

        if (
          !Number.isInteger(panelNumber) ||
          panelNumber < 1 ||
          typeof body.is_open !== "boolean"
        ) {
          return json(
            {
              ok: false,
              error: "パネルの指定が正しくありません。",
            },
            400
          );
        }

        if (!current.is_started) {
          return json(
            {
              ok: false,
              error:
                "チャレンジを開始してから操作してください。",
            },
            400
          );
        }

        if (
          panelNumber >
          current.grid_rows * current.grid_columns
        ) {
          return json(
            {
              ok: false,
              error: "パネル番号が範囲外です。",
            },
            400
          );
        }

        const panelUrl = new URL(
          `${baseUrl}/rest/v1/challenge_panels`
        );

        panelUrl.searchParams.set(
          "challenge_id",
          `eq.${current.id}`
        );

        panelUrl.searchParams.set(
          "panel_number",
          `eq.${panelNumber}`
        );

        const now = new Date().toISOString();

        const panelResponse = await fetch(panelUrl, {
          method: "PATCH",
          headers: {
            ...headers,
            Prefer: "return=representation",
          },
          body: JSON.stringify({
            is_open: body.is_open,
            opened_at: body.is_open ? now : null,
            updated_at: now,
          }),
        });

        if (!panelResponse.ok) {
          return json(
            {
              ok: false,
              error: "パネルの状態を変更できませんでした。",
            },
            502
          );
        }

        const updatedPanels = await panelResponse.json();

        if (!updatedPanels.length) {
          return json(
            {
              ok: false,
              error: "対象のパネルが見つかりません。",
            },
            404
          );
        }

        return json({
          ok: true,
          message: body.is_open
            ? "パネルを開きました。"
            : "パネルを閉じました。",
        });
      }

      return json(
        {
          ok: false,
          error: "不正な操作です。",
        },
        400
      );
    }

    // ========================================
    // POST：チャレンジ設定を保存
    // ========================================
    let body;

    try {
      body = await request.json();
    } catch {
      return json(
        {
          ok: false,
          error: "リクエストの形式が正しくありません。",
        },
        400
      );
    }

    const title =
      typeof body.title === "string"
        ? body.title.trim()
        : "";

    const rows = Number(body.grid_rows);
    const columns = Number(body.grid_columns);

    if (
      !title ||
      !Number.isInteger(rows) ||
      !Number.isInteger(columns) ||
      rows < 1 ||
      columns < 1 ||
      rows * columns > 100 ||
      !Array.isArray(body.panels)
    ) {
      return json(
        {
          ok: false,
          error: "入力内容を確認してください。",
        },
        400
      );
    }

    // 既存のチャレンジを取得
    const existingResponse = await fetch(challengeUrl, {
      headers,
    });

    if (!existingResponse.ok) {
      return json(
        {
          ok: false,
          error: "現在の設定を取得できませんでした。",
        },
        502
      );
    }

    const existingList = await existingResponse.json();
    const existing = existingList[0];

    // 終了済みチャレンジの設定変更を禁止
    if (existing?.is_ended === true) {
      return json(
        {
          ok: false,
          error: "終了したチャレンジの設定は変更できません。",
        },
        400
      );
    }

    const challengeData = {
      streamer_id: streamerId,
      title,
      grid_rows: rows,
      grid_columns: columns,
      image_position_x: Number(body.image_position_x ?? 0),
      image_position_y: Number(body.image_position_y ?? 0),
      image_scale: Number(body.image_scale ?? 100),
    };

    let challengeId;

    if (existing) {
      challengeId = existing.id;

      const updateUrl = new URL(
        `${baseUrl}/rest/v1/challenges`
      );

      updateUrl.searchParams.set("id", `eq.${challengeId}`);
      updateUrl.searchParams.set("streamer_id", `eq.${streamerId}`);
      updateUrl.searchParams.set("is_ended", "eq.false");

      const updateResponse = await fetch(updateUrl, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          title: challengeData.title,
          grid_rows: challengeData.grid_rows,
          grid_columns: challengeData.grid_columns,
          image_position_x: challengeData.image_position_x,
          image_position_y: challengeData.image_position_y,
          image_scale: challengeData.image_scale,
        }),
      });

      if (!updateResponse.ok) {
        return json(
          {
            ok: false,
            error: "設定を保存できませんでした。",
          },
          502
        );
      }
    } else {
      const createResponse = await fetch(
        `${baseUrl}/rest/v1/challenges`,
        {
          method: "POST",
          headers: {
            ...headers,
            Prefer: "return=representation",
          },
          body: JSON.stringify(challengeData),
        }
      );

      if (!createResponse.ok) {
        return json(
          {
            ok: false,
            error: "チャレンジを作成できませんでした。",
          },
          502
        );
      }

      const created = await createResponse.json();
      challengeId = created[0]?.id;

      if (!challengeId) {
        return json(
          {
            ok: false,
            error: "チャレンジIDを取得できませんでした。",
          },
          502
        );
      }
    }

    // ----------------------------------------
    // パネルの3項目を保存
    // ----------------------------------------
    for (const panel of body.panels) {
      const panelNumber = Number(panel.panel_number);

      if (
        !Number.isInteger(panelNumber) ||
        panelNumber < 1 ||
        panelNumber > rows * columns
      ) {
        continue;
      }

      const targetValue =
        panel.target_value === "" ||
        panel.target_value === null ||
        panel.target_value === undefined
          ? 0
          : Number(panel.target_value);

      const currentValue =
        panel.current_value === "" ||
        panel.current_value === null ||
        panel.current_value === undefined
          ? 0
          : Number(panel.current_value);

      if (
        !Number.isFinite(targetValue) ||
        !Number.isFinite(currentValue)
      ) {
        return json(
          {
            ok: false,
            error: `${panelNumber}番のマスの目標値・現在値は数値で入力してください。`,
          },
          400
        );
      }

      const panelData = {
        condition_text:
          typeof panel.condition_text === "string"
            ? panel.condition_text
            : "",
        target_value: targetValue,
        current_value: currentValue,
        updated_at: new Date().toISOString(),
      };

      const panelUrl = new URL(
        `${baseUrl}/rest/v1/challenge_panels`
      );

      panelUrl.searchParams.set(
        "challenge_id",
        `eq.${challengeId}`
      );

      panelUrl.searchParams.set(
        "panel_number",
        `eq.${panelNumber}`
      );

      // パネルがすでに存在するか確認
      const findUrl = new URL(panelUrl);
      findUrl.searchParams.set("select", "id");

      const findResponse = await fetch(findUrl, {
        headers,
      });

      if (!findResponse.ok) {
        return json(
          {
            ok: false,
            error: "パネル設定を確認できませんでした。",
          },
          502
        );
      }

      const found = await findResponse.json();

      if (found.length > 0) {
        // 既存パネルの3項目だけを更新
        // is_open と opened_at は変更しない
        const saveResponse = await fetch(panelUrl, {
          method: "PATCH",
          headers,
          body: JSON.stringify(panelData),
        });

        if (!saveResponse.ok) {
          return json(
            {
              ok: false,
              error: "パネル設定を保存できませんでした。",
            },
            502
          );
        }
      } else {
        // 新しいパネルを作成
        const saveResponse = await fetch(
          `${baseUrl}/rest/v1/challenge_panels`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              challenge_id: challengeId,
              panel_number: panelNumber,
              ...panelData,
              is_open: false,
            }),
          }
        );

        if (!saveResponse.ok) {
          return json(
            {
              ok: false,
              error: "パネルを作成できませんでした。",
            },
            502
          );
        }
      }
    }

    return json({
      ok: true,
      message: "保存しました。",
    });
  } catch (error) {
    console.error("Challenge API error:", error);

    return json(
      {
        ok: false,
        error: "処理中にエラーが発生しました。",
      },
      500
    );
  }
}
