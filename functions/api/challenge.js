
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

  const response = await fetch(url.toString(), {
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
    },
  });

  if (!response.ok) {
    throw new Error("Session lookup failed");
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

export async function onRequestGet({ request, env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    return json({ ok: false, error: "Server configuration error" }, 500);
  }

  try {
    const streamerId = await getStreamerId(request, env);

    if (!streamerId) {
      return json({ ok: false, error: "Not authenticated" }, 401);
    }

    const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");

    const challengeUrl = new URL(`${baseUrl}/rest/v1/challenges`);
    challengeUrl.searchParams.set("select", "*");
    challengeUrl.searchParams.set("streamer_id", `eq.${streamerId}`);
    challengeUrl.searchParams.set("limit", "1");

    const challengeResponse = await fetch(challengeUrl.toString(), {
      headers: {
        apikey: env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      },
    });

    if (!challengeResponse.ok) {
      return json({ ok: false, error: "Could not load challenge" }, 502);
    }

    const challenges = await challengeResponse.json();
    const challenge = challenges[0] || null;

    if (!challenge) {
      return json({ ok: true, challenge: null, panels: [] });
    }

    const panelsUrl = new URL(`${baseUrl}/rest/v1/challenge_panels`);
    panelsUrl.searchParams.set("select", "*");
    panelsUrl.searchParams.set("challenge_id", `eq.${challenge.id}`);
    panelsUrl.searchParams.set("order", "panel_number.asc");

    const panelsResponse = await fetch(panelsUrl.toString(), {
      headers: {
        apikey: env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      },
    });

    if (!panelsResponse.ok) {
      return json({ ok: false, error: "Could not load panels" }, 502);
    }

    const panels = await panelsResponse.json();

    return json({ ok: true, challenge, panels });
  } catch (error) {
    console.error("challenge API error:", error);
    return json({ ok: false, error: "Internal server error" }, 500);
  }
}
