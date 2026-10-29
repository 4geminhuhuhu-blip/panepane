
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

  const response = await fetch(url, {
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

function supabaseHeaders(env, extra = {}) {
  return {
    apikey: env.SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
    ...extra,
  };
}

async function uploadImage(request, env, streamerId) {
  const contentType = request.headers.get("Content-Type") || "";

  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return json({
      ok: false,
      error: "画像ファイルを選択してください",
    }, 400);
  }

  const formData = await request.formData();
  const file = formData.get("image");

  if (!file || typeof file.arrayBuffer !== "function") {
    return json({
      ok: false,
      error: "画像ファイルが見つかりません",
    }, 400);
  }

  if (file.size <= 0 || file.size > 5 * 1024 * 1024) {
    return json({
      ok: false,
      error: "画像は5MB以下のファイルを選択してください",
    }, 400);
  }

  const allowedTypes = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
  };

  const extension = allowedTypes[file.type];

  if (!extension) {
    return json({
      ok: false,
      error: "PNG・JPEG・WebP形式の画像を選択してください",
    }, 400);
  }

  // チャレンジが作成済みであることを確認
  const challengeUrl = new URL(
    "/rest/v1/challenges",
    env.SUPABASE_URL
  );
  challengeUrl.searchParams.set(
    "select",
    "id,image_url,is_started,is_ended"
  );
  challengeUrl.searchParams.set("streamer_id", `eq.${streamerId}`);
  challengeUrl.searchParams.set("limit", "1");

  const challengeResponse = await fetch(challengeUrl, {
    headers: supabaseHeaders(env),
  });

  if (!challengeResponse.ok) {
    throw new Error("Could not load challenge");
  }

  const challenges = await challengeResponse.json();
  const challenge = challenges[0];

  if (!challenge) {
    return json({
      ok: false,
      error: "先にチャレンジの設定を保存してください",
    }, 409);
  }

  // 終了済みのチャレンジでは画像を変更できない
  if (challenge.is_ended === true) {
    return json({
      ok: false,
      error: "終了済みのチャレンジでは画像を変更できません",
    }, 409);
  }

  if (challenge.is_started) {
    return json({
      ok: false,
      error: "開始済みのチャレンジでは画像を変更できません",
    }, 409);
  }

  // アカウントごとに専用の保存先を作る
  const objectPath =
    `${streamerId}/${crypto.randomUUID()}.${extension}`;

  const storagePath = objectPath
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  const uploadUrl = new URL(
    `/storage/v1/object/challenge-images/${storagePath}`,
    env.SUPABASE_URL
  );

  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: supabaseHeaders(env, {
      "Content-Type": file.type,
      "x-upsert": "false",
    }),
    body: await file.arrayBuffer(),
  });

  if (!uploadResponse.ok) {
    console.error(
      "Image upload failed:",
      uploadResponse.status,
      await uploadResponse.text()
    );

    return json({
      ok: false,
      error: "画像のアップロードに失敗しました",
    }, 502);
  }

  const imageUrl = new URL(
    `/storage/v1/object/public/challenge-images/${storagePath}`,
    env.SUPABASE_URL
  ).toString();

  // アップロード成功後に、チャレンジの画像URLを更新
  // 開始・終了状態も条件にして、状態変更後の更新を防ぐ
  const updateUrl = new URL(
    "/rest/v1/challenges",
    env.SUPABASE_URL
  );
  updateUrl.searchParams.set("id", `eq.${challenge.id}`);
  updateUrl.searchParams.set("streamer_id", `eq.${streamerId}`);
  updateUrl.searchParams.set("is_started", "eq.false");
  updateUrl.searchParams.set("is_ended", "eq.false");

  const updateResponse = await fetch(updateUrl, {
    method: "PATCH",
    headers: supabaseHeaders(env, {
      "Content-Type": "application/json",
      Prefer: "return=representation",
    }),
    body: JSON.stringify({
      image_url: imageUrl,
      updated_at: new Date().toISOString(),
    }),
  });

  if (!updateResponse.ok) {
    await updateResponse.text();

    // URL保存に失敗したら、今回アップロードした画像を削除
    const cleanupUrl = new URL(
      `/storage/v1/object/challenge-images/${storagePath}`,
      env.SUPABASE_URL
    );

    await fetch(cleanupUrl, {
      method: "DELETE",
      headers: supabaseHeaders(env),
    }).catch(() => {});

    return json({
      ok: false,
      error: "画像情報を保存できませんでした。以前の画像は維持されています",
    }, 502);
  }

  const updatedRows = await updateResponse.json();

  if (!updatedRows.length) {
    const cleanupUrl = new URL(
      `/storage/v1/object/challenge-images/${storagePath}`,
      env.SUPABASE_URL
    );

    await fetch(cleanupUrl, {
      method: "DELETE",
      headers: supabaseHeaders(env),
    }).catch(() => {});

    return json({
      ok: false,
      error: "画像を変更できませんでした。ページを再読み込みしてください",
    }, 409);
  }

  // 新しい画像が保存できた後に限り、古い画像を削除する
  const oldImageUrl = challenge.image_url;

  if (oldImageUrl) {
    try {
      const oldUrl = new URL(oldImageUrl);
      const prefix = "/storage/v1/object/public/challenge-images/";

      if (
        oldUrl.origin === new URL(env.SUPABASE_URL).origin &&
        oldUrl.pathname.startsWith(prefix)
      ) {
        const oldPath = oldUrl.pathname.slice(prefix.length);
        const deleteUrl = new URL(
          `/storage/v1/object/challenge-images/${oldPath}`,
          env.SUPABASE_URL
        );

        const deleteResponse = await fetch(deleteUrl, {
          method: "DELETE",
          headers: supabaseHeaders(env),
        });

        if (!deleteResponse.ok) {
          console.error("Old image cleanup failed:", deleteResponse.status);
        }
      }
    } catch (error) {
      console.error("Old image cleanup failed:", error);
    }
  }

  return json({
    ok: true,
    image_url: imageUrl,
  });
}

export async function onRequest({ request, env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    return json({
      ok: false,
      error: "Server configuration error",
    }, 500);
  }

  if (request.method !== "POST") {
    return json({
      ok: false,
      error: "POST method required",
    }, 405);
  }

  try {
    const streamerId = await getStreamerId(request, env);

    if (!streamerId) {
      return json({
        ok: false,
        error: "ログインの有効期限が切れています。再ログインしてください",
      }, 401);
    }

    return await uploadImage(request, env, streamerId);
  } catch (error) {
    console.error("Challenge image API error:", error);

    return json({
      ok: false,
      error: "画像処理中にエラーが発生しました",
    }, 500);
  }
}
