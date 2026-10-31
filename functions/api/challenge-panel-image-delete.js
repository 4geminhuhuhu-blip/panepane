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
  const match = cookie.match(/(?:^|;\s*)panepan_streamer_session=([^;]*)/);
  let token = "";
  try {
    token = match ? decodeURIComponent(match[1]) : "";
  } catch {
    return null;
  }
  if (!/^[a-f0-9]{64}$/i.test(token)) return null;

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const url = new URL("/rest/v1/streamer_sessions", env.SUPABASE_URL);
  url.searchParams.set("select", "streamer_id,expires_at");
  url.searchParams.set("token_hash", `eq.${hash}`);
  url.searchParams.set("limit", "1");
  const response = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
    },
  });
  if (!response.ok) throw new Error("Session lookup failed");
  const session = (await response.json())[0];
  if (!session || !session.expires_at || new Date(session.expires_at).getTime() <= Date.now()) {
    return null;
  }
  return session.streamer_id;
}

export async function onRequest({ request, env }) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "POST method required" }, 405);
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    return json({ ok: false, error: "Server configuration error" }, 500);
  }

  try {
    const streamerId = await getStreamerId(request, env);
    if (!streamerId) {
      return json({ ok: false, error: "ログインの有効期限が切れています。再ログインしてください。" }, 401);
    }

    const body = await request.json();
    const panelNumber = Number(body.panel_number);
    if (!Number.isInteger(panelNumber) || panelNumber < 1 || panelNumber > 100) {
      return json({ ok: false, error: "パネル番号が正しくありません。" }, 400);
    }

    const headers = {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
    };
    const base = env.SUPABASE_URL.replace(/\/+$/, "");

    const challengeUrl = new URL(`${base}/rest/v1/challenges`);
    challengeUrl.searchParams.set("select", "id,is_started,is_ended");
    challengeUrl.searchParams.set("streamer_id", `eq.${streamerId}`);
    challengeUrl.searchParams.set("limit", "1");
    const challengeResponse = await fetch(challengeUrl, { headers });
    if (!challengeResponse.ok) throw new Error("Challenge lookup failed");
    const challenge = (await challengeResponse.json())[0];
    if (!challenge) return json({ ok: false, error: "チャレンジ設定が見つかりません。" }, 404);
    if (challenge.is_started || challenge.is_ended) {
      return json({ ok: false, error: "チャレンジ開始後・終了後は画像を削除できません。" }, 409);
    }

    const panelUrl = new URL(`${base}/rest/v1/challenge_panels`);
    panelUrl.searchParams.set("select", "panel_number,panel_image_url");
    panelUrl.searchParams.set("challenge_id", `eq.${challenge.id}`);
    panelUrl.searchParams.set("panel_number", `eq.${panelNumber}`);
    panelUrl.searchParams.set("limit", "1");
    const panelResponse = await fetch(panelUrl, { headers });
    if (!panelResponse.ok) throw new Error("Panel lookup failed");
    const panel = (await panelResponse.json())[0];
    if (!panel || !panel.panel_image_url) {
      return json({ ok: false, error: "このパネルには画像が登録されていません。" }, 404);
    }

    // Delete only an object inside this streamer's own challenge-images folder.
    const imageUrl = new URL(panel.panel_image_url);
    const expectedOrigin = new URL(base).origin;
    const publicPrefix = "/storage/v1/object/public/challenge-images/";
    if (imageUrl.origin !== expectedOrigin || !imageUrl.pathname.startsWith(publicPrefix)) {
      return json({ ok: false, error: "登録画像の保存先を確認できないため削除できません。" }, 400);
    }
    const encodedObjectPath = imageUrl.pathname.slice(publicPrefix.length);
    const objectPath = encodedObjectPath.split("/").map((part) => decodeURIComponent(part)).join("/");
    if (!objectPath.startsWith(`${streamerId}/panels/`) || objectPath.includes("..")) {
      return json({ ok: false, error: "この画像を削除する権限がありません。" }, 403);
    }

    const storagePath = objectPath.split("/").map(encodeURIComponent).join("/");
    const deleteUrl = new URL(`/storage/v1/object/challenge-images/${storagePath}`, base);
    const deleteResponse = await fetch(deleteUrl, { method: "DELETE", headers });
    if (!deleteResponse.ok && deleteResponse.status !== 404) {
      console.error("Panel image delete failed", deleteResponse.status, await deleteResponse.text());
      return json({ ok: false, error: "画像ファイルを削除できませんでした。" }, 502);
    }

    const updateUrl = new URL(`${base}/rest/v1/challenge_panels`);
    updateUrl.searchParams.set("challenge_id", `eq.${challenge.id}`);
    updateUrl.searchParams.set("panel_number", `eq.${panelNumber}`);
    updateUrl.searchParams.set("select", "panel_number");
    const updateResponse = await fetch(updateUrl, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ panel_image_url: null, updated_at: new Date().toISOString() }),
    });
    if (!updateResponse.ok) {
      console.error("Panel image URL clear failed", updateResponse.status, await updateResponse.text());
      return json({ ok: false, error: "画像URLを解除できませんでした。ページを再読み込みして確認してください。" }, 502);
    }

    return json({ ok: true, panel_number: panelNumber });
  } catch (error) {
    console.error("Panel image delete error", error);
    return json({ ok: false, error: "画像の削除中にエラーが発生しました。" }, 500);
  }
}
