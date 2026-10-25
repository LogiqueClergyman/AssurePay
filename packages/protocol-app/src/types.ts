import type { Address, Hex, LocalAccount } from 'viem';
import type { PilotConfig } from '../../developer-pilot/src/config.js';

export type Role = 'admin' | 'provider' | 'adjudicator' | 'operator';
export type SigningRole = Exclude<Role, 'operator'>;
export interface ProtocolConsoleAssets {
  readonly html: string;
  readonly javascript: string;
  readonly stylesheet: string;
}
export interface ProtocolConsoleHostOptions {
  readonly role: Role;
  readonly assets: ProtocolConsoleAssets;
}
export interface StartProtocolServerOptions {
  readonly runtime: ProtocolRuntime;
  readonly console?: ProtocolConsoleHostOptions;
}
export interface ProtocolConfig { readonly version: 1; readonly pilot: PilotConfig; readonly admin: Address; readonly apiUrl: string }
export interface Anchor { readonly number: string; readonly hash: Hex; readonly timestamp: string }
export interface Limits { readonly maxActionAmount: string; readonly maxActions: number }
export interface ProtocolOptions {
  readonly config: ProtocolConfig;
  readonly storage: Readonly<{ directory: string; key: Uint8Array }>;
  readonly accounts?: Readonly<Partial<Record<SigningRole, LocalAccount>>>;
  readonly limits: Limits;
}
export interface Summary {
  paused: boolean; tokenBalanceAtomic: string; poolAssets: string; poolReserved: string;
  providerStake: string; lockedStake: string; coverageCount: string; activeCoverageCount: string;
  solvency: { balanceCoversAssetsAndStake: boolean; stakeCoversLocks: boolean; poolCoversReservations: boolean };
}
export interface ProviderRow {
  providerId: Hex; owner: Address; payout: Address; freeStake: string; lockedStake: string;
  payoutBalanceAtomic: string; cumulativeNetPaidAtomic: string; coverageCountsByStatus: Record<string, string>;
}
export interface PolicyRow {
  policyId: Hex; providerId: Hex; policyHash: Hex; premiumBps: number; stakeBps: number;
  withholdingBps: number; duration: string; poolOnlyAllowed: boolean;
}
export interface CoverageRow {
  coverageId: Hex; payer: Address; providerId: Hex; policyId: Hex; gross: string; premium: string;
  withheld: string; stakeLock: string; poolReservation: string; openedAt: string; expiresAt: string;
  poolOnlyAllowed: boolean; status: number; hasEvidence: boolean; outcome?: number; refundAmount?: string;
}
export interface ReadSnapshot { anchor: Anchor; summary: Summary; providers: readonly ProviderRow[]; policies: readonly PolicyRow[]; coverages: readonly CoverageRow[] }
export type Operation =
  | { kind: 'registerProvider'; providerId: Hex; owner: Address; payout: Address }
  | { kind: 'registerPolicy'; policyId: Hex; providerId: Hex; premiumBps: number; stakeBps: number; withholdingBps: number; duration: string; poolOnlyAllowed: boolean }
  | { kind: 'setPaused'; paused: boolean }
  | { kind: 'approveCore'; amount: string }
  | { kind: 'depositStake' | 'withdrawStake'; providerId: Hex; amount: string }
  | { kind: 'fundPool'; amount: string }
  | { kind: 'finalizeClaim'; coverageId: Hex; outcome: 0 | 1 | 2; refundAmount: string; reason: string };
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export interface ActionPreview {
  previewId: Hex; role: SigningRole; actor: Address; operation: Operation['kind'];
  review: Readonly<Record<string, Json>>; chainId: 84532; core: Address;
  anchor: Anchor; expiresAt: string; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string;
}
export interface ActionResult {
  operationId: Hex; operation: Operation['kind']; actor: Address;
  status: 'reserved' | 'prepared' | 'unknown' | 'success' | 'reverted';
  transaction?: Hex; inclusion?: { number: string; hash: Hex };
}
export interface RoleSender {
  preview(operation: unknown): Promise<ActionPreview>;
  confirm(previewId: Hex, approval: Readonly<{ approved: true }>): Promise<ActionResult>;
  reconcile(): Promise<readonly ActionResult[]>;
  close(): Promise<void>;
}
export interface ProtocolRuntime {
  readonly config: ProtocolConfig;
  readonly capabilities: Readonly<Record<Role, readonly Operation['kind'][]>>;
  snapshot(): Promise<ReadSnapshot>;
  assertAnchor(anchor: Anchor): Promise<void>;
  preview(role: Role, operation: unknown): Promise<ActionPreview>;
  confirm(role: Role, previewId: Hex, approval: Readonly<{ approved: true }>): Promise<ActionResult>;
  reconcile(role: Role): Promise<readonly ActionResult[]>;
  readEvidence(role: Role, coverageId: Hex): Promise<Uint8Array>;
  close(): Promise<void>;
}
export interface ProtocolServer {
  readonly url: string;
  issueBootstrap(role: Role): string;
  close(): Promise<void>;
}
