function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function getStreamerId(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)panepan_streamer_session=([^;]*)/);
  let token = "";
  try { token = match ? decodeURIComponent(match[1]) : ""; } catch { return null; }
  if (!/^[a-f0-9]{64}$/i.test(token)) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
  const url = new URL("/rest/v1/streamer_sessions", env.SUPABASE_URL);
  url.searchParams.set("select", "streamer_id,expires_at");
  url.searchParams.set("token_hash", `eq.${hash}`);
  url.searchParams.set("limit", "1");
  const response = await fetch(url, { headers: { apikey: env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}` } });
  if (!response.ok) throw new Error("Session lookup failed");
  const rows = await response.json();
  const session = rows[0];
  if (!session || !session.expires_at || new Date(session.expires_at).getTime() <= Date.now()) return null;
  return session.streamer_id;
}

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return json({ ok: false, error: "POST method required" }, 405);
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) return json({ ok: false, error: "Server configuration error" }, 500);
  try {
    const streamerId = await getStreamerId(request, env);
    if (!streamerId) return json({ ok: false, error: "ログインの有効期限が切れています。再ログインしてください。" }, 401);
    const type = request.headers.get("Content-Type") || "";
    if (!type.toLowerCase().startsWith("multipart/form-data")) return json({ ok: false, error: "画像ファイルを選択してください。" }, 400);
    const form = await request.formData();
    const file = form.get("image");
    const panelNumber = Number(form.get("panel_number"));
    if (!Number.isInteger(panelNumber) || panelNumber < 1 || panelNumber > 100) return json({ ok: false, error: "パネル番号が正しくありません。" }, 400);
    if (!file || typeof file.arrayBuffer !== "function") return json({ ok: false, error: "画像ファイルが見つかりません。" }, 400);
    if (file.size <= 0 || file.size > 2 * 1024 * 1024) return json({ ok: false, error: "画像は2MB以下のファイルを選択してください。" }, 400);
    const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
    const extension = extensions[file.type];
    if (!extension) return json({ ok: false, error: "PNG・JPEG・WebP形式の画像を選択してください。" }, 400);

    const headers = { apikey: env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}` };
    const base = env.SUPABASE_URL.replace(/\/+$/, "");
    const challengeUrl = new URL(`${base}/rest/v1/challenges`);
    challengeUrl.searchParams.set("select", "id,is_started,is_ended");
    challengeUrl.searchParams.set("streamer_id", `eq.${streamerId}`);
    challengeUrl.searchParams.set("limit", "1");
    const challengeResponse = await fetch(challengeUrl, { headers });
    if (!challengeResponse.ok) throw new Error("Challenge lookup failed");
    const challenge = (await challengeResponse.json())[0];
    if (!challenge) return json({ ok: false, error: "先にチャレンジの設定を保存してください。" }, 409);
    if (challenge.is_started || challenge.is_ended) return json({ ok: false, error: "チャレンジ開始後・終了後はパネル画像を変更できません。" }, 409);

    const objectPath = `${streamerId}/panels/${crypto.randomUUID()}.${extension}`;
    const encodedPath = objectPath.split("/").map(encodeURIComponent).join("/");
    const uploadUrl = new URL(`/storage/v1/object/challenge-images/${encodedPath}`, base);
    const uploadResponse = await fetch(uploadUrl, { method: "POST", headers: { ...headers, "Content-Type": file.type, "x-upsert": "false" }, body: await file.arrayBuffer() });
    if (!uploadResponse.ok) {
      console.error("Panel image upload failed", uploadResponse.status, await uploadResponse.text());
      return json({ ok: false, error: "画像のアップロードに失敗しました。" }, 502);
    }
    const imageUrl = new URL(`/storage/v1/object/public/challenge-images/${encodedPath}`, base).toString();
    const panelUrl = new URL(`${base}/rest/v1/challenge_panels`);
    panelUrl.searchParams.set("challenge_id", `eq.${challenge.id}`);
    panelUrl.searchParams.set("panel_number", `eq.${panelNumber}`);
    panelUrl.searchParams.set("select", "panel_number");
    const updateResponse = await fetch(panelUrl, { method: "PATCH", headers: { ...headers, "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify({ panel_image_url: imageUrl, updated_at: new Date().toISOString() }) });
    if (!updateResponse.ok) {
      console.error("Panel image URL save failed", updateResponse.status, await updateResponse.text());
      return json({ ok: false, error: "画像URLを保存できませんでした。" }, 502);
    }
    const updated = await updateResponse.json();
    if (!updated.length) {
      return json({ ok: false, error: "先にパネル設定を保存してから画像を登録してください。" }, 409);
    }
    return json({ ok: true, panel_number: panelNumber, panel_image_url: imageUrl });
  } catch (error) {
    console.error("Panel image upload error", error);
    return json({ ok: false, error: "画像の登録中にエラーが発生しました。" }, 500);
  }
}
