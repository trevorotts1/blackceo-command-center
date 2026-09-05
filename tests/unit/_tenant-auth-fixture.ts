import { createHmac } from 'node:crypto';
export function registerFixtureTenant(host: string) {
  process.env.MC_TENANT_REGISTRY_JSON=JSON.stringify({[host]:{tenantId:'fixture-self',companyId:'default',kind:'self',installationId:'fixture-install'}});
}
export function fixtureTenantCookie(host:string):string {
  const secret=process.env.MC_TENANT_SESSION_SECRET||process.env.MC_INTERVIEW_COOKIE_SECRET||process.env.MC_API_TOKEN;
  if(!secret)return '';
  const payload=Buffer.from(JSON.stringify({purpose:'session',tenantId:'fixture-self',subject:'owner:fixture',host,installationId:'fixture-install',exp:Date.now()/1000+3600,nonce:'fixture-browser'})).toString('base64url');
  return `mc_tenant_session=${payload}.${createHmac('sha256',secret).update(payload).digest('base64url')}`;
}
export const fixtureTenantScope=(host:string)=>`fixture-self:fixture-install:${host}`;
