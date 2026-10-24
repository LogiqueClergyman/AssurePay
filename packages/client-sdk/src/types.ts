import type { Address, Hex, LocalAccount } from 'viem';

export interface ClientConfig {
  readonly version: 1; readonly mode: 'local'; readonly chainId: 84532;
  readonly rpcUrl: string; readonly core: Address; readonly token: Address;
  readonly providerId: Hex; readonly policyId: Hex; readonly serviceId: Hex;
  readonly roles: Readonly<{ relayer: Address; payer: Address; provider: Address; adjudicator: Address }>;
  readonly resourceUrl: string; readonly claimsUrl: string;
  readonly deploymentBlock: string; readonly gross: string;
}
export interface ClientTerms {
  readonly chainId: 84532; readonly core: Address; readonly token: Address;
  readonly providerId: Hex; readonly policyId: Hex; readonly policyHash: Hex;
  readonly providerOwner: Address; readonly providerPayout: Address;
  readonly premiumBps: number; readonly stakeBps: number; readonly withholdingBps: number;
  readonly duration: string; readonly poolOnlyAllowed: boolean;
  readonly gross: string; readonly premium: string; readonly withheld: string; readonly net: string;
  readonly stakeLock: string; readonly poolReservation: string;
  readonly tokenName: 'USDC'; readonly tokenVersion: '2';
}
export interface ClientOptions {
  readonly config: ClientConfig;
  readonly maxGross: string;
  readonly budget: Readonly<{ maxTotalGross: string; maxPayments: number }>;
  readonly storage: Readonly<{ directory: string; key: Uint8Array }>;
  readonly payerAccount?: LocalAccount;
}
export interface ClientPreview {
  readonly requestId: Hex; readonly requestHash: Hex; readonly bodyHash: Hex;
  readonly url: string; readonly payer: Address; readonly serviceId: Hex;
  readonly maxGross: string; readonly expiresAt: string; readonly terms: ClientTerms;
}
export interface AuthorizedRequest {
  readonly requestId: Hex; readonly requestHash: Hex; readonly coverageId: Hex;
}
export interface BlockAnchor { readonly number: string; readonly hash: Hex }
export interface ObservedBlock extends BlockAnchor { readonly timestamp: string }
export interface ReceiptSummary {
  readonly chainId: string; readonly core: Address; readonly coverageId: Hex;
  readonly requestHash: Hex; readonly responseHash: Hex;
  readonly status: number; readonly completedAt: string;
}
export interface ConfirmedResult extends AuthorizedRequest {
  readonly state: 'confirmed'; readonly status: number; readonly body: Uint8Array;
  readonly transaction: Hex; readonly paymentBlock: BlockAnchor;
  readonly receipt: ReceiptSummary; readonly receiptFingerprint: Hex;
}
export interface RetrievalRequired extends AuthorizedRequest {
  readonly state: 'retrieval-required'; readonly code: 'CLIENT_RETRIEVAL_REQUIRED';
}
export type ClientResult = ConfirmedResult | RetrievalRequired;
export interface ClientCoverage {
  readonly coverageId: Hex; readonly payer: Address; readonly providerId: Hex; readonly policyId: Hex;
  readonly requestHash: Hex; readonly status: number; readonly outcome: number;
  readonly gross: string; readonly premium: string; readonly withheld: string;
  readonly stakeLock: string; readonly poolReservation: string;
  readonly openedAt: string; readonly expiresAt: string; readonly poolOnlyAllowed: boolean;
  readonly refundAmount: string;
}
export interface ClientState {
  readonly chainId: 84532; readonly core: Address; readonly token: Address; readonly payer: Address;
  readonly tokenBalanceAtomic: string; readonly observedBlock: ObservedBlock;
  readonly coverage?: ClientCoverage;
}
export interface ClaimSubmission {
  readonly coverageId: Hex; readonly transaction: Hex;
  readonly status: 'pending' | 'success' | 'reverted';
  readonly inclusion?: BlockAnchor;
}
export interface Client {
  preview(body: Uint8Array): Promise<ClientPreview>;
  authorize(requestId: Hex, approval: Readonly<{ approved: true }>): Promise<AuthorizedRequest>;
  send(requestId: Hex): Promise<ClientResult>;
  retrieve(requestId: Hex): Promise<ClientResult>;
  readState(coverageId?: Hex): Promise<ClientState>;
  uploadEvidence(coverageId: Hex, body: Uint8Array): Promise<Hex>;
  readEvidence(coverageId: Hex, evidenceHash: Hex): Promise<Uint8Array>;
  fileClaim(coverageId: Hex, evidenceHash: Hex, approval: Readonly<{ approved: true }>): Promise<ClaimSubmission>;
  reconcileClaims(): Promise<readonly ClaimSubmission[]>;
  close(): Promise<void>;
}
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export interface AgentTool {
  readonly name: 'assurepay_preview' | 'assurepay_pay' | 'assurepay_retrieve' | 'assurepay_state';
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, JsonValue>>;
}
export interface AgentOptions {
  readonly client: Client;
  readonly approvePayment: (preview: ClientPreview) => boolean | Promise<boolean>;
}
export interface AgentTools {
  readonly tools: readonly AgentTool[];
  invoke(name: string, args: unknown): Promise<JsonValue>;
}
