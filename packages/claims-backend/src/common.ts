import { createHash } from 'node:crypto';
import { keccak256, toBytes, type Address, type Hex } from 'viem';
import type { BackendContext, OpeningAnchor } from './types.js';
export function canonicalJson(value:unknown):string {
  function visit(v:unknown,depth:number):unknown {
    if(depth>16)throw new Error('INVALID_JSON');
    if(v===null||typeof v==='string'||typeof v==='boolean')return v;
    if(typeof v==='number'&&Number.isSafeInteger(v))return v;
    if(Array.isArray(v))return v.map(child=>visit(child,depth+1));
    if(v&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype){
      return Object.fromEntries(Object.keys(v).sort().map(key=>[key,visit((v as Record<string,unknown>)[key],depth+1)]));
    }
    throw new Error('INVALID_JSON');
  }
  return JSON.stringify(visit(value,0));
}
export const hashJson=(value:unknown):Hex=>keccak256(toBytes(canonicalJson(value)));
export function requireId(value:unknown,allowZero=false):Hex {
  if(typeof value!=='string'||!/^0x[0-9a-f]{64}$/.test(value)||(!allowZero&&/^0x0{64}$/.test(value)))throw new Error('INVALID_ID');
  return value as Hex;
}
export function requireAddress(value:unknown):Address {
  if(typeof value!=='string'||!/^0x[0-9a-f]{40}$/.test(value)||/^0x0{40}$/.test(value))throw new Error('INVALID_ADDRESS');
  return value as Address;
}
export function uint(value:unknown):bigint {
  if(typeof value!=='string'||value.length>78||!/^(0|[1-9][0-9]*)$/.test(value)||BigInt(value)>=(1n<<256n))throw new Error('INVALID_UINT');
  return BigInt(value);
}
export function exact(value:unknown,keys:string[]):Record<string,any> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new Error('INVALID_SCHEMA');
  return value as Record<string,any>;
}
export function normalizeContext(value:BackendContext):BackendContext {
  exact(value,['chainId','core','token','adjudicator','serviceId']);
  if(value.chainId!==84532)throw new Error('INVALID_CONTEXT');
  return Object.freeze({chainId:84532,core:requireAddress(value.core.toLowerCase()),token:requireAddress(value.token.toLowerCase()),adjudicator:requireAddress(value.adjudicator.toLowerCase()),serviceId:requireId(value.serviceId)});
}
export const contextNamespace=(context:BackendContext):string=>createHash('sha256').update(canonicalJson(normalizeContext(context))).digest('hex');
export const sameAnchor=(a:OpeningAnchor,b:OpeningAnchor)=>canonicalJson(a)===canonicalJson(b);
