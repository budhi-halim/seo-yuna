import { env } from 'cloudflare:workers';
import { createOwnerHandler } from '../../../../owner/api.mjs';

export const dynamic = 'force-dynamic';

async function handle(request: Request) {
  return createOwnerHandler({ env })(request);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
