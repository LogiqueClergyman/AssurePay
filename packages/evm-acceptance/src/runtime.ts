import { keccak256, toBytes, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { validateConfig, NATIVE_USDC, MAX_FEE_PER_GAS, MAX_PRIORITY_FEE_PER_GAS } from './plan.js';
import type { Actor, RunConfig } from './types.js';
export const PUBLIC_SCOPE='m5-two-http-refunds-paused-revert-once';
export function runtimeConfig(env:Readonly<Record<string,string|undefined>>):RunConfig {
 const runId=env.M5_RUN_ID;if(!runId||!/^0x[0-9a-f]{64}$/.test(runId))throw new Error('M5_RUN_ID_REQUIRED');
 const id=(name:string)=>keccak256(toBytes(`${runId}:${name}`));
 return validateConfig({version:1,mode:'public',chainId:84532,token:NATIVE_USDC,roles:{payer:env.EXPECTED_PAYER,relayer:env.RELAYER_ADDRESS,provider:env.PROVIDER_PAYOUT,adjudicator:env.M5_ADJUDICATOR_ADDRESS},runId,providerId:id('provider'),policyId:id('policy'),serviceId:id('service'),resourceUrl:env.M5_RESOURCE_URL??'http://127.0.0.1:40205/assured',maxFeePerGas:MAX_FEE_PER_GAS,maxPriorityFeePerGas:MAX_PRIORITY_FEE_PER_GAS});
}
export function runtimeRpc(env:Readonly<Record<string,string|undefined>>):string {
 const value=env.BASE_SEPOLIA_RPC_URL??'https://sepolia.base.org';
 try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.hash)throw new Error();return value;}catch{throw new Error('M5_RPC_CONFIG_INVALID');}
}
export function runtimeAccounts(env:Readonly<Record<string,string|undefined>>,config:RunConfig){
 const names:Record<Actor,string>={payer:'PAYER_PRIVATE_KEY',relayer:'RELAYER_PRIVATE_KEY',provider:'PROVIDER_PAYOUT_PRIVATE_KEY',adjudicator:'M5_ADJUDICATOR_PRIVATE_KEY'};
 const accounts={} as Record<Actor,ReturnType<typeof privateKeyToAccount>>;
 for(const actor of Object.keys(names) as Actor[]){
  const value=env[names[actor]];if(!value||!/^0x[0-9a-fA-F]{64}$/.test(value))throw new Error('M5_SIGNER_CONFIG_REQUIRED');
  try{const account=privateKeyToAccount(value as Hex);if(account.address.toLowerCase()!==config.roles[actor])throw new Error();accounts[actor]=account;}catch{throw new Error('M5_SIGNER_CONFIG_MISMATCH');}
 }
 return accounts;
}
export function runtimeDataKey(env:Readonly<Record<string,string|undefined>>):Uint8Array {
 const key=env.M5_DATA_KEY_HEX;if(!key||!/^[0-9a-f]{64}$/.test(key))throw new Error('M5_DATA_KEY_REQUIRED');return Uint8Array.from(Buffer.from(key,'hex'));
}
export const safeCode=(error:unknown)=>error instanceof Error&&/^[A-Z][A-Z0-9_]{0,100}$/.test(error.message)?error.message:'M5_OPERATION_FAILED';
