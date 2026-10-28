
export async function onRequest({ env }) {
  return new Response(
    JSON.stringify({
      ok: true,
      supabaseUrlConfigured: Boolean(env.SUPABASE_URL),
      publishableKeyConfigured: Boolean(
        env.SUPABASE_PUBLISHABLE_KEY
      ),
      secretKeyConfigured: Boolean(env.SUPABASE_SECRET_KEY),
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
