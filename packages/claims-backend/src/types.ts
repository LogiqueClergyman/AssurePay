import type { Address, Hex } from 'viem';
export interface BackendContext { chainId:84532; core:Address; token:Address; adjudicator:Address; serviceId:Hex }
export interface OpeningAnchor { transaction:Hex; blockNumber:string; blockHash:Hex; logIndex:string }
export interface CoverageView {
  coverageId:Hex; payer:Address; providerId:Hex; policyId:Hex; policyHash:Hex; requestHash:Hex;
  gross:string; premium:string; withheld:string; stakeLock:string; poolReservation:string;
  openedAt:string; expiresAt:string; poolOnlyAllowed:boolean; status:number;
  evidenceHash:Hex; decisionHash:Hex; refundAmount:string; outcome:number; opening:OpeningAnchor;
}
export interface Snapshot { version:1; context:BackendContext; fromBlock:string; head:{number:string;hash:Hex;timestamp:string}; coverages:Record<string,CoverageView> }
export interface Projection { refresh():Promise<Snapshot> }
export interface PreparedAction { chainId:84532; to:Address; from:Address; data:Hex; value:'0'; coverageId:Hex; observedBlock:{number:string;hash:Hex} }
export type ObjectKind='result'|'evidence'|'decision';
export interface Vault { put(kind:ObjectKind,id:Hex,value:unknown):Promise<void>; get(kind:ObjectKind,id:Hex):Promise<unknown|undefined> }
export type Operation='uploadEvidence'|'readEvidence'|'prepareClaim'|'prepareDecision';
export interface Authorization { actor:Address; operation:Operation; coverageId:Hex; payloadHash:Hex; nonce:Hex; deadline:string; signature:Hex }
export interface DecisionInput { outcome:0|1|2; refundAmount:string; reason:string }
