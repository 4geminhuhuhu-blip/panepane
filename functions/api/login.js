
export async function onRequest({ request }) {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "POST method required" }),
      {
        status: 405,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "Allow": "POST",
        },
      }
    );
  }

  return new Response(
    JSON.stringify({
      ok: false,
      message: "Login is not configured yet.",
    }),
    {
      status: 501,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    }
  );
}
