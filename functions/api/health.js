
export async function onRequest({ env }) {
  const hasUrl = Boolean(env.SUPABASE_URL);
  const hasPublishableKey = Boolean(env.SUPABASE_PUBLISHABLE_KEY);

  return new Response(
    JSON.stringify({
      ok: true,
      supabaseUrlConfigured: hasUrl,
      publishableKeyConfigured: hasPublishableKey,
      message: "Panepan API is working",
    }),
    {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    }
  );
}
