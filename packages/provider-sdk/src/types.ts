import type { Address, Hex, LocalAccount } from 'viem';

/** Public, local-only deployment identity. Amounts are atomic decimal strings. */
export interface ProviderConfig {
  readonly version: 1;
  readonly mode: 'local';
  readonly chainId: 84532;
  readonly rpcUrl: string;
  readonly core: Address;
  readonly token: Address;
  readonly providerId: Hex;
  readonly policyId: Hex;
  readonly serviceId: Hex;
  readonly roles: Readonly<{
    relayer: Address;
    payer: Address;
    provider: Address;
    adjudicator: Address;
  }>;
  readonly resourceUrl: string;
  readonly claimsUrl: string;
  readonly deploymentBlock: string;
  readonly gross: string;
}

export type ReceiptSigner = Readonly<Pick<LocalAccount, 'address' | 'signTypedData'>>;

export interface ProviderOptions {
  readonly config: ProviderConfig;
  readonly storage: Readonly<{ directory: string; key: Uint8Array }>;
  readonly receiptSigner: ReceiptSigner;
  readonly relayerAccount?: LocalAccount;
  readonly handler: (body: Uint8Array) => Uint8Array | Promise<Uint8Array>;
}

export interface ProviderService {
  readonly resourceUrl: string;
  readonly claimsUrl: string;
  readonly mode: 'settlement-enabled' | 'retrieval-only';
  close(): Promise<void>;
}
