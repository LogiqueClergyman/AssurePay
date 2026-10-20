import type { Address, Hex } from 'viem';

export interface Trust {
  chainId: 84532;
  core: Address;
  token: Address;
  providerId: Hex;
  policyId: Hex;
}
export interface Terms extends Trust {
  providerOwner: Address;
  providerPayout: Address;
  policyHash: Hex;
  premiumBps: number;
  stakeBps: number;
  withholdingBps: number;
  duration: string;
  poolOnlyAllowed: boolean;
  gross: string;
  premium: string;
  withheld: string;
  net: string;
  stakeLock: string;
  poolReservation: string;
  tokenName: 'USDC';
  tokenVersion: '2';
}
export interface Intent {
  chainId: string;
  core: Address;
  token: Address;
  payer: Address;
  providerId: Hex;
  policyId: Hex;
  policyHash: Hex;
  requestHash: Hex;
  gross: string;
  payerSalt: Hex;
  validAfter: string;
  validBefore: string;
}
export interface PreparedCall {
  intent: Intent;
  intentHash: Hex;
  signature: Hex;
  to: Address;
  data: Hex;
}
export interface PaymentResult {
  state: 'confirmed' | 'pending' | 'reverted' | 'invalid';
  transaction: Hex | '';
  coverageId: Hex;
  blockNumber?: string;
  blockHash?: Hex;
}
export interface SettlementEngine {
  settle(call: PreparedCall): Promise<PaymentResult>;
  /** Verify an existing durable identity only; never sign or submit. */
  reconcile?(call: PreparedCall): Promise<PaymentResult>;
}
export interface PayerSigner {
  address: Address;
  signTypedData(data: any): Promise<Hex>;
}
export interface ReceiptMessage {
  chainId: string;
  core: Address;
  coverageId: Hex;
  requestHash: Hex;
  responseHash: Hex;
  status: number;
  completedAt: string;
}
export interface SignedReceipt { message: ReceiptMessage; signature: Hex }
export interface DurableServiceResult {
  coverageId: Hex; requestHash: Hex; transaction: Hex; blockNumber: string; blockHash: Hex;
  status: number; body: Uint8Array; receipt: SignedReceipt;
}
export interface ResultStore {
  put(context: string, result: DurableServiceResult): Promise<void>;
  get(context: string, coverageId: Hex, requestHash: Hex): Promise<DurableServiceResult | undefined>;
}
export interface CanonicalRequest {
  url: string;
  method: 'POST';
  contentType: 'application/octet-stream';
  body: Uint8Array;
  requestId: Hex;
}
