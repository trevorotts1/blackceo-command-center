import { proxyTenantBoard } from '@/lib/tenant-board-proxy';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ path: string[] }> };
const handle = async (request: Request, context: Context) => proxyTenantBoard(request, (await context.params).path);
export { handle as GET, handle as HEAD, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
