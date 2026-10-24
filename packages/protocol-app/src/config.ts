import { localUrl, validateConfig } from '../../developer-pilot/src/config.js';
import { address, exact } from './common.js';
import type { ProtocolConfig } from './types.js';

export function validateProtocolConfig(input: unknown): ProtocolConfig {
  try {
  const row = exact(input, ['version', 'pilot', 'admin', 'apiUrl']);
  if (row.version !== 1) throw Error('PROTOCOL_CONFIG_INVALID');
  const pilot = validateConfig(row.pilot), admin = address(row.admin), apiUrl = localUrl(row.apiUrl, true);
  if (Object.values(pilot.roles).includes(admin) || [pilot.rpcUrl,pilot.resourceUrl,pilot.claimsUrl].some(url => new URL(url).origin === apiUrl))
    throw Error('PROTOCOL_CONFIG_INVALID');
  return Object.freeze({ version: 1, pilot, admin, apiUrl });
  } catch { throw Error('PROTOCOL_CONFIG_INVALID'); }
}
