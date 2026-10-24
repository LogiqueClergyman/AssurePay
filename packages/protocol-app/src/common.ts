import { keccak256, toBytes, type Address, type Hex } from 'viem';
import type { ProtocolConfig, Role } from './types.js';

export function exact(value: unknown, fields: readonly string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw Error('PROTOCOL_ARGUMENT_INVALID');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))) throw Error('PROTOCOL_ARGUMENT_INVALID');
  for (const key of fields) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) throw Error('PROTOCOL_ARGUMENT_INVALID');
  }
  return value as Record<string, any>;
}
export function amount(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78 || BigInt(value) >= (1n << 256n))
    throw Error('PROTOCOL_AMOUNT_INVALID');
  return value;
}
export function id(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value) || /^0x0{64}$/.test(value)) throw Error('PROTOCOL_ID_INVALID');
  return value as Hex;
}
export function address(value: unknown): Address {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/i.test(value) || /^0x0{40}$/i.test(value)) throw Error('PROTOCOL_ADDRESS_INVALID');
  return value.toLowerCase() as Address;
}
export function roleAddress(config: ProtocolConfig, role: Role): Address {
  if (role === 'admin') return config.admin;
  if (role === 'provider') return config.pilot.roles.provider;
  if (role === 'adjudicator') return config.pilot.roles.adjudicator;
  if (role === 'operator') return config.pilot.roles.relayer;
  throw Error('PROTOCOL_ROLE_INVALID');
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const hashValue = (value: unknown): Hex => keccak256(toBytes(stable(value)));
export const same = (a: unknown, b: unknown): boolean => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
