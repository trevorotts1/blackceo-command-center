import { proxyTenantBoard } from '@/lib/tenant-board-proxy';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: { path: string[] } };
const handle = (request: Request, context: Context) => proxyTenantBoard(request, context.params.path);
export { handle as GET, handle as HEAD, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
