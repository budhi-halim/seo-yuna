export const dynamic = 'force-dynamic';

const source = 'https://budhi-halim.github.io/seo-yuna/data.json';

export async function GET() {
  try {
    const upstream = await fetch(source, {
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!upstream.ok) throw new Error('Catalog unavailable');
    return new Response(upstream.body, { headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    } });
  } catch {
    return Response.json({ error: 'The published collection is temporarily unavailable. Refresh to try again.' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
