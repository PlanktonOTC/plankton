// Vercel function: every /api/* call from the site reaches the PlanktonOTC API through here (see vercel.json), so the
// browser never calls the API directly. Settings: API_ORIGIN (the API's address) and WEB_PROXY_TOKEN (shared with the API).
import { DEFAULT_API_ORIGIN, forward } from '../proxy-core.mjs';

async function handle(request) {
  const url = new URL(request.url);
  const path = `/${(url.searchParams.get('__path') ?? '').replace(/^\/+/, '')}`;
  url.searchParams.delete('__path');
  // Vercel sets x-real-ip and x-forwarded-for itself, overwriting anything the browser sent.
  const visitorIp = request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forward(request, {
    apiOrigin: process.env.API_ORIGIN || DEFAULT_API_ORIGIN,
    path,
    search: url.search,
    visitorIp,
    proxyToken: process.env.WEB_PROXY_TOKEN || undefined,
  });
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const DELETE = handle;
