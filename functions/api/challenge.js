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
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    return json({ ok: false, error: "Server configuration error" }, 500);
  }

  try {
    const streamerId = await getStreamerId(request, env);

    if (!streamerId) {
      return json({
        ok: false,
        error: "ログインの有効期限が切れています。再ログインしてください。",
      }, 401);
    }

    const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");

    const headers = {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
    };

    const challengeUrl = new URL(`${baseUrl}/rest/v1/challenges`);

    challengeUrl.searchParams.set(
      "select",
      "id,streamer_id,title,grid_rows,grid_columns,image_url,image_position_x,image_position_y,image_scale,is_started,is_ended,featured_panel_number,thank_you_message,show_watermark,auto_gift_target_pt"
    );

    challengeUrl.searchParams.set("streamer_id", `eq.${streamerId}`);
    challengeUrl.searchParams.set("limit", "1");

    // GET：チャレンジとパネル情報を取得
    if (request.method === "GET") {
      const challengeResponse = await fetch(challengeUrl, { headers });

      if (!challengeResponse.ok) {
        return json({
          ok: false,
          error: "チャレンジ情報を取得できませんでした。",
        }, 502);
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
        "panel_number,condition_text,target_value,current_value,count_value,is_open,auto_reason,is_gift_free,auto_target_pt,auto_gift_point,panel_image_url"
      );
      panelsUrl.searchParams.set("challenge_id", `eq.${record.id}`);
      // 保存済みの余剰パネルは削除せず、現在の設定枚数だけ返す。
      // 縮小後も旧データを保持し、再拡張時の復元を可能にする。
      panelsUrl.searchParams.set("panel_number", `lte.${Number(record.grid_rows) * Number(record.grid_columns)}`);
      panelsUrl.searchParams.set("order", "panel_number.asc");

      const panelsResponse = await fetch(panelsUrl, { headers });

      if (!panelsResponse.ok) {
        return json({
          ok: false,
          error: "パネル情報を取得できませんでした。",
        }, 502);
      }

      return json({
        ok: true,
        challenge: record,
        panels: await panelsResponse.json(),
      });
    }

    // PATCH：チャレンジ操作
    if (request.method === "PATCH") {
      let body;

      try {
        body = await request.json();
      } catch {
        return json({
          ok: false,
          error: "リクエストの形式が正しくありません。",
        }, 400);
      }

      const currentResponse = await fetch(challengeUrl, { headers });

      if (!currentResponse.ok) {
        return json({
          ok: false,
          error: "チャレンジ情報を取得できませんでした。",
        }, 502);
      }

      const currentList = await currentResponse.json();
      const current = currentList[0];

      if (!current) {
        return json({
          ok: false,
          error: "チャレンジが見つかりません。",
        }, 404);
      }

      // お礼メッセージ・透かし設定は、チャレンジ終了後も変更可能
      if (body.action === "update-public-settings") {
        const updateData = {};

        if (Object.prototype.hasOwnProperty.call(body, "thank_you_message")) {
          if (
            body.thank_you_message !== null &&
            typeof body.thank_you_message !== "string"
          ) {
            return json({
              ok: false,
              error: "お礼メッセージの入力内容が正しくありません。",
            }, 400);
          }

          const message =
            typeof body.thank_you_message === "string"
              ? body.thank_you_message.trim()
              : null;

          if (message !== null && message.length > 5000) {
            return json({
              ok: false,
              error: "お礼メッセージは5000文字以内で入力してください。",
            }, 400);
          }

          updateData.thank_you_message = message || null;
        }

        if (Object.prototype.hasOwnProperty.call(body, "show_watermark")) {
          if (typeof body.show_watermark !== "boolean") {
            return json({
              ok: false,
              error: "透かしの設定値が正しくありません。",
            }, 400);
          }

          updateData.show_watermark = body.show_watermark;
        }

        if (Object.keys(updateData).length === 0) {
          return json({
            ok: false,
            error: "保存する設定がありません。",
          }, 400);
        }

        const publicSettingsUrl = new URL(
          `${baseUrl}/rest/v1/challenges`
        );

        publicSettingsUrl.searchParams.set("id", `eq.${current.id}`);
        publicSettingsUrl.searchParams.set("streamer_id", `eq.${streamerId}`);

        const response = await fetch(publicSettingsUrl, {
          method: "PATCH",
          headers: {
            ...headers,
            Prefer: "return=representation",
          },
          body: JSON.stringify(updateData),
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error("Public settings update failed:", errorText);

          return json({
            ok: false,
            error: "お礼メッセージ・透かし設定を保存できませんでした。",
          }, 502);
        }

        const updated = await response.json();

        if (!updated.length) {
          return json({
            ok: false,
            error: "設定を保存できませんでした。",
          }, 400);
        }

        return json({
          ok: true,
          thank_you_message: updated[0].thank_you_message,
          show_watermark: updated[0].show_watermark,
          message: "設定を保存しました。",
        });
      }

      // 終了後は、お礼メッセージ・透かし設定以外の操作を禁止
      if (current.is_ended === true) {
        return json({
          ok: false,
          error: "このチャレンジは終了しています。再開できません。",
        }, 400);
      }

      // 重点パネル指定・解除
      if (body.action === "set-featured-panel") {
        const panelNumber =
          body.panel_number === null
            ? null
            : Number(body.panel_number);

        if (
          panelNumber !== null &&
          (
            !Number.isInteger(panelNumber) ||
            panelNumber < 1 ||
            panelNumber > current.grid_rows * current.grid_columns
          )
        ) {
          return json({
            ok: false,
            error: "重点パネルの番号が正しくありません。",
          }, 400);
        }

        const updateUrl = new URL(
          `${baseUrl}/rest/v1/challenges`
        );

        updateUrl.searchParams.set("id", `eq.${current.id}`);
        updateUrl.searchParams.set("streamer_id", `eq.${streamerId}`);
        updateUrl.searchParams.set("is_ended", "eq.false");

        const response = await fetch(updateUrl, {
          method: "PATCH",
          headers: {
            ...headers,
            Prefer: "return=representation",
          },
          body: JSON.stringify({
            featured_panel_number: panelNumber,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error("Featured panel update failed:", errorText);

          return json({
            ok: false,
            error: "重点パネルを保存できませんでした。",
          }, 502);
        }

        const updated = await response.json();

        if (!updated.length) {
          return json({
            ok: false,
            error: "重点パネルを保存できませんでした。",
          }, 400);
        }

        return json({
          ok: true,
          featured_panel_number: panelNumber,
          message: panelNumber === null
            ? "重点パネルを解除しました。"
            : "重点パネルを設定しました。",
        });
      }

      // チャレンジ開始：立ち絵と全条件の必須項目を確認
      if (body.action === "start") {
        if (!current.image_url) {
          return json({ ok: false, error: "チャレンジ開始前に立ち絵画像をアップロードしてください。" }, 400);
        }
        const requiredPanelsUrl = new URL(`${baseUrl}/rest/v1/challenge_panels`);
        requiredPanelsUrl.searchParams.set("select", "panel_number,condition_text,target_value");
        requiredPanelsUrl.searchParams.set("challenge_id", `eq.${current.id}`);
        requiredPanelsUrl.searchParams.set("panel_number", `lte.${Number(current.grid_rows) * Number(current.grid_columns)}`);
        requiredPanelsUrl.searchParams.set("order", "panel_number.asc");
        const requiredPanelsResponse = await fetch(requiredPanelsUrl, { headers });
        if (!requiredPanelsResponse.ok) {
          return json({ ok: false, error: "条件の入力内容を確認できませんでした。" }, 502);
        }
        const requiredPanels = await requiredPanelsResponse.json();
        const expectedPanelCount = Number(current.grid_rows) * Number(current.grid_columns);
        if (requiredPanels.length !== expectedPanelCount || requiredPanels.some(panel => !String(panel.condition_text || "").trim() || !String(panel.target_value || "").trim())) {
          return json({ ok: false, error: "すべての条件の「項目」と「目標」を入力してから開始してください。" }, 400);
        }

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
          body: JSON.stringify({ is_started: true }),
        });

        if (!response.ok) {
          return json({
            ok: false,
            error: "チャレンジを開始できませんでした。",
          }, 502);
        }

        const updated = await response.json();

        if (!updated.length) {
          return json({
            ok: false,
            error: "チャレンジを開始できませんでした。",
          }, 400);
        }

        return json({
          ok: true,
          message: "チャレンジを開始しました。",
        });
      }

      // チャレンジ終了
      if (body.action === "end") {
        if (!current.is_started) {
          return json({
            ok: false,
            error: "開始前のチャレンジは終了できません。",
          }, 400);
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
          body: JSON.stringify({ is_ended: true }),
        });

        if (!response.ok) {
          return json({
            ok: false,
            error: "チャレンジを終了できませんでした。",
          }, 502);
        }

        const updated = await response.json();

        if (!updated.length) {
          return json({
            ok: false,
            error: "チャレンジはすでに終了している可能性があります。",
          }, 400);
        }

        return json({
          ok: true,
          message: "チャレンジを終了しました。",
        });
      }

      // 配信中カウンター：現在値を直接編集
      if (body.action === "set-panel-count") {
        const panelNumber = Number(body.panel_number);
        const countValue = Number(body.count_value);
        if (!Number.isInteger(panelNumber) || panelNumber < 1 ||
            !Number.isSafeInteger(countValue) || countValue < 0 || countValue > 2147483647) {
          return json({ ok: false, error: "カウント数は0以上の整数で入力してください。" }, 400);
        }
        if (!current.is_started || current.is_ended) {
          return json({ ok: false, error: "配信中のチャレンジでのみ編集できます。" }, 400);
        }
        if (panelNumber > current.grid_rows * current.grid_columns) {
          return json({ ok: false, error: "パネル番号が範囲外です。" }, 400);
        }
        const updateUrl = new URL(`${baseUrl}/rest/v1/challenge_panels`);
        updateUrl.searchParams.set("challenge_id", `eq.${current.id}`);
        updateUrl.searchParams.set("panel_number", `eq.${panelNumber}`);
        const updateResponse = await fetch(updateUrl, {
          method: "PATCH",
          headers: { ...headers, Prefer: "return=representation" },
          body: JSON.stringify({ count_value: countValue, updated_at: new Date().toISOString() }),
        });
        if (!updateResponse.ok) {
          console.error("Panel count direct edit failed:", await updateResponse.text());
          return json({ ok: false, error: "カウント数を保存できませんでした。" }, 502);
        }
        const updated = await updateResponse.json();
        if (!updated.length) return json({ ok: false, error: "対象のパネルが見つかりません。" }, 404);
        return json({ ok: true, panel_number: panelNumber, count_value: Number(updated[0].count_value) || 0 });
      }

      // 配信中カウンター：目標数を直接編集（数値のみ）
      if (body.action === "set-panel-target") {
        const panelNumber = Number(body.panel_number);
        const targetValue = String(body.target_value == null ? "" : body.target_value).trim();
        if (!Number.isInteger(panelNumber) || panelNumber < 1 ||
            !/^\d+$/.test(targetValue) || !Number.isSafeInteger(Number(targetValue)) || Number(targetValue) < 1) {
          return json({ ok: false, error: "目標は1以上の整数で入力してください。" }, 400);
        }
        if (!current.is_started || current.is_ended) {
          return json({ ok: false, error: "配信中のチャレンジでのみ編集できます。" }, 400);
        }
        if (panelNumber > current.grid_rows * current.grid_columns) {
          return json({ ok: false, error: "パネル番号が範囲外です。" }, 400);
        }
        const updateUrl = new URL(`${baseUrl}/rest/v1/challenge_panels`);
        updateUrl.searchParams.set("challenge_id", `eq.${current.id}`);
        updateUrl.searchParams.set("panel_number", `eq.${panelNumber}`);
        const updateResponse = await fetch(updateUrl, {
          method: "PATCH",
          headers: { ...headers, Prefer: "return=representation" },
          body: JSON.stringify({ target_value: targetValue, updated_at: new Date().toISOString() }),
        });
        if (!updateResponse.ok) {
          console.error("Panel target edit failed:", await updateResponse.text());
          return json({ ok: false, error: "目標数を保存できませんでした。" }, 502);
        }
        const updated = await updateResponse.json();
        if (!updated.length) return json({ ok: false, error: "対象のパネルが見つかりません。" }, 404);
        return json({ ok: true, panel_number: panelNumber, target_value: updated[0].target_value });
      }

      // 配信中カウンター：個別パネルのカウントを安全に加減算
      if (body.action === "adjust-panel-count") {
        const panelNumber = Number(body.panel_number);
        const delta = Number(body.delta);

        if (
          !Number.isInteger(panelNumber) ||
          panelNumber < 1 ||
          ![1, 5, 10, 50, 100, 1000].includes(delta)
        ) {
          return json({ ok: false, error: "カウントの指定が正しくありません。" }, 400);
        }

        if (!current.is_started || current.is_ended) {
          return json({ ok: false, error: "配信中のチャレンジでのみカウントできます。" }, 400);
        }

        if (panelNumber > current.grid_rows * current.grid_columns) {
          return json({ ok: false, error: "パネル番号が範囲外です。" }, 400);
        }

        const panelInfoUrl = new URL(`${baseUrl}/rest/v1/challenge_panels`);
        panelInfoUrl.searchParams.set("select", "panel_number,condition_text,is_gift_free,auto_gift_point");
        panelInfoUrl.searchParams.set("challenge_id", `eq.${current.id}`);
        panelInfoUrl.searchParams.set("panel_number", `eq.${panelNumber}`);
        panelInfoUrl.searchParams.set("limit", "1");

        const panelInfoResponse = await fetch(panelInfoUrl, { headers });
        if (!panelInfoResponse.ok) {
          return json({ ok: false, error: "パネル情報を確認できませんでした。" }, 502);
        }

        const panelInfoList = await panelInfoResponse.json();
        const panelInfo = panelInfoList[0];
        if (!panelInfo) {
          return json({ ok: false, error: "対象のパネルが見つかりません。" }, 404);
        }

        const conditionText = String(panelInfo.condition_text || "");
        const giftPointFromText = conditionText.match(/([0-9][0-9,]*)\s*(?:ポイント|pt)/i);
        const giftPoint = panelInfo.is_gift_free === true
          ? 0
          : (Number(panelInfo.auto_gift_point) > 0
              ? Number(panelInfo.auto_gift_point)
              : (giftPointFromText ? Number(giftPointFromText[1].replace(/,/g, "")) : 0));

        // 0PT項目は+1/+5/+10/+50/+100/+1000、1〜99PTは+1/+5/+10、100PT以上は+1のみ。
        const allowedDeltas = giftPoint === 0
          ? [1, 5, 10, 50, 100, 1000]
          : giftPoint < 100 ? [1, 5, 10] : [1];
        if (!allowedDeltas.includes(delta)) {
          return json({ ok: false, error: "このパネルでは選択できない加算数です。" }, 400);
        }

        const rpcResponse = await fetch(`${baseUrl}/rest/v1/rpc/panepane_adjust_panel_count`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            p_challenge_id: current.id,
            p_streamer_id: streamerId,
            p_panel_number: panelNumber,
            p_delta: delta,
          }),
        });

        if (!rpcResponse.ok) {
          const errorText = await rpcResponse.text();
          console.error("Panel count update failed:", errorText);
          return json({ ok: false, error: "カウントを保存できませんでした。通信状態を確認して、もう一度お試しください。" }, 502);
        }

        const countValue = await rpcResponse.json();
        return json({
          ok: true,
          panel_number: panelNumber,
          count_value: Number(countValue) || 0,
        });
      }

      // パネルの開閉
      if (body.action === "set-panel") {
        const panelNumber = Number(body.panel_number);

        if (
          !Number.isInteger(panelNumber) ||
          panelNumber < 1 ||
          typeof body.is_open !== "boolean"
        ) {
          return json({
            ok: false,
            error: "パネルの指定が正しくありません。",
          }, 400);
        }

        if (!current.is_started) {
          return json({
            ok: false,
            error: "チャレンジを開始してから操作してください。",
          }, 400);
        }

        if (
          panelNumber >
          current.grid_rows * current.grid_columns
        ) {
          return json({
            ok: false,
            error: "パネル番号が範囲外です。",
          }, 400);
        }

        const panelUrl = new URL(
          `${baseUrl}/rest/v1/challenge_panels`
        );

        panelUrl.searchParams.set("challenge_id", `eq.${current.id}`);
        panelUrl.searchParams.set("panel_number", `eq.${panelNumber}`);

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
          return json({
            ok: false,
            error: "パネルの状態を変更できませんでした。",
          }, 502);
        }

        const updatedPanels = await panelResponse.json();

        if (!updatedPanels.length) {
          return json({
            ok: false,
            error: "対象のパネルが見つかりません。",
          }, 404);
        }

        return json({
          ok: true,
          message: body.is_open
            ? "パネルを開きました。"
            : "パネルを閉じました。",
        });
      }

      return json({
        ok: false,
        error: "不正な操作です。",
      }, 400);
    }

    // POST：チャレンジ設定を保存
    let body;

    try {
      body = await request.json();
    } catch {
      return json({
        ok: false,
        error: "リクエストの形式が正しくありません。",
      }, 400);
    }

    const title =
      typeof body.title === "string"
        ? body.title.trim()
        : "";

    const rows = Number(body.grid_rows);
    const columns = Number(body.grid_columns);
    const autoGiftTargetPt = body.auto_gift_target_pt == null || body.auto_gift_target_pt === ""
      ? null : Number(body.auto_gift_target_pt);

    if (autoGiftTargetPt !== null && (!Number.isSafeInteger(autoGiftTargetPt) || autoGiftTargetPt <= 0)) {
      return json({ ok: false, error: "自動作成の配分対象ポイントが正しくありません。" }, 400);
    }

    if (
      !title ||
      title.length > 100 ||
      !Number.isInteger(rows) ||
      !Number.isInteger(columns) ||
      rows < 3 ||
      columns < 3 ||
      rows > 10 ||
      columns > 10 ||
      rows * columns > 100 ||
      !Array.isArray(body.panels)
    ) {
      return json({
        ok: false,
        error: "入力内容を確認してください。タイトルは1〜100文字、マス数は縦・横ともに3〜10で入力してください。",
      }, 400);
    }

    const panelNumbers = new Set();
    const panelDataList = [];
    const now = new Date().toISOString();

    for (const panel of body.panels) {
      const panelNumber = Number(panel.panel_number);

      if (
        !Number.isInteger(panelNumber) ||
        panelNumber < 1 ||
        panelNumber > rows * columns
      ) {
        return json({
          ok: false,
          error: "パネル番号が正しくありません。",
        }, 400);
      }

      if (panelNumbers.has(panelNumber)) {
        return json({
          ok: false,
          error: `${panelNumber}番のパネルが重複しています。`,
        }, 400);
      }

      panelNumbers.add(panelNumber);

      const conditionText =
        typeof panel.condition_text === "string"
          ? panel.condition_text
          : "";

      const targetValue =
        typeof panel.target_value === "string"
          ? panel.target_value
          : panel.target_value == null
            ? ""
            : String(panel.target_value);

      const currentValue =
        typeof panel.current_value === "string"
          ? panel.current_value
          : panel.current_value == null
            ? ""
            : String(panel.current_value);

      const autoReason =
        typeof panel.auto_reason === "string" && panel.auto_reason.length <= 80
          ? panel.auto_reason
          : null;
      const isGiftFree = panel.is_gift_free === true;
      const autoTargetPt = panel.auto_target_pt == null || panel.auto_target_pt === ""
        ? null : Number(panel.auto_target_pt);
      const autoGiftPoint = panel.auto_gift_point == null || panel.auto_gift_point === ""
        ? null : Number(panel.auto_gift_point);
      const panelImageUrl = typeof panel.panel_image_url === "string" && panel.panel_image_url.length <= 2048
        ? panel.panel_image_url : null;

      if (
        (autoTargetPt !== null && (!Number.isSafeInteger(autoTargetPt) || autoTargetPt < 0)) ||
        (autoGiftPoint !== null && (!Number.isSafeInteger(autoGiftPoint) || autoGiftPoint <= 0))
      ) {
        return json({ ok: false, error: `${panelNumber}番の自動作成ポイント情報が正しくありません。` }, 400);
      }

      if (!conditionText.trim() || !targetValue.trim()) {
        return json({ ok: false, error: `条件 ${panelNumber} の「項目」と「目標」は必須です。` }, 400);
      }

      if (
        conditionText.length > 500 ||
        targetValue.length > 500 ||
        currentValue.length > 500
      ) {
        return json({
          ok: false,
          error: `${panelNumber}番の条件はそれぞれ500文字以内で入力してください。`,
        }, 400);
      }

      panelDataList.push({
        panel_number: panelNumber,
        condition_text: conditionText,
        target_value: targetValue,
        current_value: currentValue,
        auto_reason: autoReason,
        is_gift_free: isGiftFree,
        auto_target_pt: autoTargetPt,
        auto_gift_point: autoGiftPoint,
        panel_image_url: panelImageUrl,
        updated_at: now,
      });
    }

    if (panelNumbers.size !== rows * columns) {
      return json({ ok: false, error: "すべての条件を入力してください。" }, 400);
    }

    const existingResponse = await fetch(challengeUrl, { headers });

    if (!existingResponse.ok) {
      return json({
        ok: false,
        error: "現在の設定を取得できませんでした。",
      }, 502);
    }

    const existingList = await existingResponse.json();
    const existing = existingList[0];

    if (existing?.is_ended === true) {
      return json({
        ok: false,
        error: "終了したチャレンジの設定は変更できません。",
      }, 400);
    }

    const challengeData = {
      streamer_id: streamerId,
      title,
      grid_rows: rows,
      grid_columns: columns,
      image_position_x: Number(body.image_position_x ?? 0),
      image_position_y: Number(body.image_position_y ?? 0),
      image_scale: Number(body.image_scale ?? 100),
      auto_gift_target_pt: autoGiftTargetPt,
    };

    // 新規チャレンジでは透かしを初期状態でONにする。
    // 既存チャレンジでは、指定がある項目だけを更新する。
    if (typeof body.show_watermark === "boolean") {
      challengeData.show_watermark = body.show_watermark;
    }

    if (Object.prototype.hasOwnProperty.call(body, "thank_you_message")) {
      if (
        body.thank_you_message !== null &&
        typeof body.thank_you_message !== "string"
      ) {
        return json({
          ok: false,
          error: "お礼メッセージの入力内容が正しくありません。",
        }, 400);
      }

      const message =
        typeof body.thank_you_message === "string"
          ? body.thank_you_message.trim()
          : null;

      if (message !== null && message.length > 5000) {
        return json({
          ok: false,
          error: "お礼メッセージは5000文字以内で入力してください。",
        }, 400);
      }

      challengeData.thank_you_message = message || null;
    }

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
        body: JSON.stringify(challengeData),
      });

      if (!updateResponse.ok) {
        return json({
          ok: false,
          error: "設定を保存できませんでした。",
        }, 502);
      }
    } else {
      if (!Object.prototype.hasOwnProperty.call(challengeData, "show_watermark")) {
        challengeData.show_watermark = true;
      }

      if (!Object.prototype.hasOwnProperty.call(challengeData, "thank_you_message")) {
        challengeData.thank_you_message = null;
      }

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
        return json({
          ok: false,
          error: "チャレンジを作成できませんでした。",
        }, 502);
      }

      const created = await createResponse.json();
      challengeId = created[0]?.id;

      if (!challengeId) {
        return json({
          ok: false,
          error: "チャレンジIDを取得できませんでした。",
        }, 502);
      }
    }

    // パネル一括保存。開閉状態は上書きしない
    if (panelDataList.length > 0) {
      const panelsUrl = new URL(
        `${baseUrl}/rest/v1/challenge_panels`
      );

      panelsUrl.searchParams.set(
        "on_conflict",
        "challenge_id,panel_number"
      );

      const panelsToSave = panelDataList.map((panel) => ({
        challenge_id: challengeId,
        ...panel,
      }));

      const saveResponse = await fetch(panelsUrl, {
        method: "POST",
        headers: {
          ...headers,
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(panelsToSave),
      });

      if (!saveResponse.ok) {
        const errorText = await saveResponse.text();
        console.error("Panel bulk save failed:", errorText);

        return json({
          ok: false,
          error: "パネル設定を一括保存できませんでした。",
        }, 502);
      }
    }

    return json({
      ok: true,
      message: "保存しました。",
    });
  } catch (error) {
    console.error("Challenge API error:", error);

    return json({
      ok: false,
      error: "処理中にエラーが発生しました。",
    }, 500);
  }
}
