import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { resolve, parse } from 'node:path';
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { withReadQueue } from '../../evm-acceptance/src/read-queue.js';
import { withLogChunks } from '../../evm-acceptance/src/log-chunks.js';
import type { BackendContext } from '../../claims-backend/src/types.js';

export interface PilotConfig {
  version: 1; mode: 'local'; chainId: 84532;
  rpcUrl: string; core: Address; token: Address;
  providerId: Hex; policyId: Hex; serviceId: Hex;
  roles: { relayer: Address; payer: Address; provider: Address; adjudicator: Address };
  resourceUrl: string; claimsUrl: string; deploymentBlock: string; gross: string;
}
export function exact(value: unknown, keys: readonly string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) throw new Error('PILOT_SCHEMA_INVALID');
  return value as Record<string, any>;
}
export function atomic(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78 || BigInt(value) >= 1n << 256n) throw new Error('PILOT_AMOUNT_INVALID');
  return value;
}
export function address(value: unknown): Address {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) throw new Error('PILOT_ADDRESS_INVALID');
  return value.toLowerCase() as Address;
}
export function id(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value) || /^0x0{64}$/.test(value)) throw new Error('PILOT_ID_INVALID');
  return value as Hex;
}
export function localUrl(value: unknown, base = false): string {
  try {
    if (typeof value !== 'string') throw new Error();
    const u = new URL(value);
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port || !/^[1-9][0-9]*$/.test(u.port) ||
        u.username || u.password || u.search || u.hash || (base && u.pathname !== '/')) throw new Error();
    return base ? u.origin : u.toString();
  } catch { throw new Error('PILOT_LOCAL_URL_REQUIRED'); }
}
export function validateConfig(input: unknown): PilotConfig {
  const row = exact(structuredClone(input), ['version','mode','chainId','rpcUrl','core','token','providerId','policyId','serviceId','roles','resourceUrl','claimsUrl','deploymentBlock','gross']);
  const roleInput = exact(row.roles, ['relayer','payer','provider','adjudicator']);
  const roles = Object.fromEntries(Object.entries(roleInput).map(([k,v]) => [k,address(v)])) as PilotConfig['roles'];
  if (row.version !== 1 || row.mode !== 'local' || row.chainId !== 84532 || new Set(Object.values(roles)).size !== 4) throw new Error('PILOT_CONFIG_INVALID');
  const token = address(row.token);
  if (token === '0x036cbd53842c5426634e7929541ec2318f3dcf7e') throw new Error('PILOT_LOCAL_TOKEN_REQUIRED');
  const config: PilotConfig = { version:1, mode:'local', chainId:84532, rpcUrl:localUrl(row.rpcUrl), core:address(row.core), token,
    providerId:id(row.providerId),policyId:id(row.policyId),serviceId:id(row.serviceId),roles,
    resourceUrl:localUrl(row.resourceUrl),claimsUrl:localUrl(row.claimsUrl,true),deploymentBlock:atomic(row.deploymentBlock),gross:atomic(row.gross) };
  if (BigInt(config.gross) < 2n || config.resourceUrl === `${config.claimsUrl}/` || new URL(config.resourceUrl).port === new URL(config.claimsUrl).port) throw new Error('PILOT_CONFIG_INVALID');
  Object.freeze(roles); return Object.freeze(config);
}
export function contextFor(config: PilotConfig): BackendContext {
  return { chainId:84532,core:config.core,token:config.token,adjudicator:config.roles.adjudicator,serviceId:config.serviceId };
}
export function trustFor(config: PilotConfig) {
  return {chainId:84532 as const, core:config.core,token:config.token,providerId:config.providerId,policyId:config.policyId};
}
export async function readConfig(path: string): Promise<PilotConfig> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) throw new Error();
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened=await handle.stat();if(!opened.isFile()||opened.size>16_384)throw new Error();
      const bytes=await handle.readFile();if(bytes.length>16_384)throw new Error();
      return validateConfig(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
    } finally { await handle.close(); }
  } catch { throw new Error('PILOT_CONFIG_INVALID'); }
}
export async function ensureDirectory(path: string): Promise<string> {
  const directory = resolve(path);
  if (parse(directory).root === directory) throw new Error('PILOT_DIRECTORY_INVALID');
  try {
    await mkdir(directory, {recursive:true,mode:0o700});
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
    return directory;
  } catch { throw new Error('PILOT_DIRECTORY_INVALID'); }
}
export function createClients(input: PilotConfig) {
  const config = validateConfig(input);
  const transport = http(config.rpcUrl, {retryCount:0,timeout:15_000});
  return {client:withLogChunks(withReadQueue(createPublicClient({chain:baseSepolia,transport,cacheTime:0}))),
    wallet:createWalletClient({chain:baseSepolia,transport,cacheTime:0})};
}
export function safeCode(error: unknown): string {
  return error instanceof Error && /^[A-Z][A-Z0-9_]{0,100}$/.test(error.message) ? error.message : 'PILOT_OPERATION_FAILED';
}
