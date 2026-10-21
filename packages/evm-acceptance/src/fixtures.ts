import { keccak256, toBytes } from 'viem';
import { hashRequest } from '../../x402-assurance/src/canonical.js';
import type { RunConfig } from './types.js';
export const requestIdFor=(config:RunConfig,name:string)=>keccak256(toBytes(`${config.runId}:${name}`));
export const requestBodyFor=(name:'purchaseA'|'purchaseB')=>toBytes(`assurepay-m5-synthetic-purchase-${name==='purchaseA'?'A':'B'}`);
export const requestHashFor=(config:RunConfig,name:'purchaseA'|'purchaseB')=>hashRequest('POST',config.resourceUrl,'application/octet-stream',requestBodyFor(name),requestIdFor(config,name));
export const rollbackRequestHashFor=(config:RunConfig)=>keccak256(toBytes(`${config.runId}:paused-admission`));
