import { readConfig, validateConfig } from '../../developer-pilot/src/config.js';
import { createClientRuntime } from './client.js';
import { clientErrorCode as clientErrorCodeInternal } from './errors.js';
import { createAgentTools as createAgentToolsInternal } from './agent.js';
import type { AgentOptions, AgentTools, Client, ClientConfig, ClientOptions } from './types.js';

export type * from './types.js';
export function clientErrorCode(error: unknown): string { return clientErrorCodeInternal(error); }
export function createAgentTools(options: AgentOptions): AgentTools {
  try { return createAgentToolsInternal(options); }
  catch (error) { throw Error(clientErrorCodeInternal(error)); }
}
export function validateClientConfig(input: unknown): ClientConfig {
  try { return validateConfig(input); } catch (error) { throw Error(clientErrorCode(error)); }
}
export async function readClientConfig(path: string): Promise<ClientConfig> {
  try { return await readConfig(path); } catch (error) { throw Error(clientErrorCode(error)); }
}
export function createClient(options: ClientOptions): Promise<Client> { return createClientRuntime(options); }
