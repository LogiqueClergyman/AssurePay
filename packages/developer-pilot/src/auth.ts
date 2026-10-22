import { operationPayloadHash, operationTypedData, randomNonce, type Authorization, type Operation } from '../../claims-backend/src/index.js';
import { contextFor, type PilotConfig } from './config.js';
import type { Hex } from 'viem';
export async function authorize(client:any,config:PilotConfig,account:any,operation:Operation,coverageId:Hex,payload:unknown):Promise<Authorization>{
  const message={actor:account.address.toLowerCase(),operation,coverageId,payloadHash:operationPayloadHash(payload),nonce:randomNonce(),deadline:String((await client.getBlock({blockTag:'latest'})).timestamp+250n)};
  return {...message,signature:await account.signTypedData(operationTypedData(contextFor(config),message))};
}
