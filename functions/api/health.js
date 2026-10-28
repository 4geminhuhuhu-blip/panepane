
export async function onRequest() {
  return new Response(
    JSON.stringify({
      ok: true,
      message: "Panepan API is working",
    }),
    {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
    }
  );
}
