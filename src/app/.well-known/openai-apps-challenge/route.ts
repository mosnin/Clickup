export function GET() {
  const token = process.env.OPENAI_APPS_CHALLENGE;
  if (!token) return new Response("Not configured", { status: 404 });
  return new Response(token, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
