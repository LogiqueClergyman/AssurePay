import type { Address, Hex } from 'viem';
export type Actor='relayer'|'payer'|'provider'|'adjudicator';
export type Roles=Record<Actor,Address>;
export type StepKind='deploy'|'provider'|'policy'|'approve'|'stake'|'pool'|'purchaseA'|'claimA'|'resolveA'|'purchaseB'|'claimB'|'resolveB'|'pause'|'revert';
export interface RunConfig {
 version:1; mode:'local'|'public';chainId:84532;token:Address;roles:Roles;runId:Hex;
 providerId:Hex;policyId:Hex;serviceId:Hex;resourceUrl:string;
 maxFeePerGas:string;maxPriorityFeePerGas:string;
}
export interface StepSpec {kind:StepKind;actor:Actor;to:Address|null;data:Hex}
export interface TransactionRecord {
 kind:StepKind;transaction:Hex;from:Address;to:Address|null;nonce:string;calldataHash:Hex;
 gas:string;maxFeePerGas:string;maxPriorityFeePerGas:string;value:'0';attempted:boolean;
 blockNumber?:string;blockHash?:Hex;status?:'success'|'reverted';
}
export interface CampaignManifest {version:1;config:RunConfig;core:Address|null;transactions:TransactionRecord[]}
export interface VerifiedTransaction {kind:StepKind;transaction:Hex;blockNumber:string;blockHash:Hex;gasUsed:string;effectiveGasPrice:string;executionFeeWei:string;l1FeeWei:string;operatorFeeWei:string;calldataBytes:number}
export interface VerificationReport {ok:boolean;code:string;transactions:VerifiedTransaction[];limits:{finality:false;httpProvenFromChain:false;postReceiveRollbackProven:false}}
