import { randomBytes } from 'node:crypto';
import { x402Client } from '@x402/core/client';
import { x402Facilitator } from '@x402/core/facilitator';
import { x402ResourceServer } from '@x402/core/server';
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SchemeNetworkClient, SchemeNetworkFacilitator, SchemeNetworkServer } from '@x402/core/types';
import {
  encodeAbiParameters, encodeFunctionData, keccak256, recoverTypedDataAddress, toBytes,
  type Address, type Hex,
} from 'viem';
import { CORE_ABI } from './core-abi.js';
import { canonicalRequestUrl, hashRequest, validateCanonicalRequest } from './canonical.js';
import { signReceipt, verifyReceipt } from './receipt.js';
import type { Intent, PayerSigner, PreparedCall, SettlementEngine, Terms } from './types.js';

export const SCHEME = 'assured-exact';
export const PROFILE = 'assurepay-evm-v2';
export const TRANSFER_METHOD = 'assured-eip3009-receive-v2';
export const PAYMENT_FLOW = 'upfront';
export { canonicalRequestUrl, hashRequest, validateCanonicalRequest, signReceipt, verifyReceipt };
export const MAX_AUTHORIZATION_SECONDS = 300n;
const NETWORK = 'eip155:84532' as const;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO32 = `0x${'00'.repeat(32)}`;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const INTENT_LITERAL = 'AssuredIntentV1(uint256 chainId,address core,address token,address payer,bytes32 providerId,bytes32 policyId,bytes32 policyHash,bytes32 requestHash,uint256 gross,bytes32 payerSalt,uint256 validAfter,uint256 validBefore)';
const INTENT_KEYS = ['chainId','core','token','payer','providerId','policyId','policyHash','requestHash','gross','payerSalt','validAfter','validBefore'];
const TERM_KEYS = ['chainId','core','token','providerId','policyId','providerOwner','providerPayout','policyHash','premiumBps','stakeBps','withholdingBps','duration','poolOnlyAllowed','gross','premium','withheld','net','stakeLock','poolReservation','tokenName','tokenVersion'];
const TERM_EXTRA_KEYS = ['profile','assetTransferMethod','paymentFlow','name','version','providerId','policyId','policyHash','requestHash','providerOwner','providerPayout','premiumBps','stakeBps','withholdingBps','duration','poolOnlyAllowed','gross','premium','withheld','providerNet','stakeLock','poolReservation'];

function obj(value: unknown, keys: readonly string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('INVALID_PAYMENT');
  const o = value as Record<string, unknown>;
  if (Object.keys(o).length !== keys.length || keys.some(k => !Object.hasOwn(o, k))) throw new Error('INVALID_PAYMENT');
  return o;
}
function uint(value: unknown, key: string): bigint {
  if (typeof value !== 'string' || value.length > 78 || !UINT.test(value) || BigInt(value) >= (1n << 256n)) throw new Error(`INVALID_${key.toUpperCase()}`);
  return BigInt(value);
}
function addr(value: unknown, key: string): Address {
  if (typeof value !== 'string' || !ADDRESS.test(value) || value === ZERO_ADDRESS) throw new Error(`INVALID_${key.toUpperCase()}`);
  return value as Address;
}
function bytes32(value: unknown, key: string, allowZero = false): Hex {
  if (typeof value !== 'string' || !BYTES32.test(value) || (!allowZero && value === ZERO32)) throw new Error(`INVALID_${key.toUpperCase()}`);
  return value as Hex;
}
function exactKeys(value: unknown, keys: readonly string[]): Record<string, any> { return obj(value, keys); }

function validateTerms(terms: Terms): void {
  exactKeys(terms, TERM_KEYS);
  if (terms.chainId !== 84532 || terms.tokenName !== 'USDC' || terms.tokenVersion !== '2') throw new Error('INVALID_TERMS');
  addr(terms.core, 'core'); addr(terms.token, 'token'); addr(terms.providerOwner, 'provider_owner'); addr(terms.providerPayout, 'provider_payout');
  bytes32(terms.providerId, 'provider_id'); bytes32(terms.policyId, 'policy_id'); bytes32(terms.policyHash, 'policy_hash');
  const amounts = Object.fromEntries((['duration','gross','premium','withheld','net','stakeLock','poolReservation'] as const).map(k => [k,uint(terms[k],k)]));
  if ([terms.premiumBps,terms.stakeBps,terms.withholdingBps].some(x => !Number.isSafeInteger(x) || x < 0 || x > 10_000) || terms.premiumBps > 9_999 || terms.withholdingBps > 9_999 || typeof terms.poolOnlyAllowed !== 'boolean') throw new Error('INVALID_TERMS');
  const {gross,premium,withheld,net,stakeLock,poolReservation}=amounts;
  if (gross < 2n || premium !== (gross * BigInt(terms.premiumBps) / 10_000n || 1n) || premium >= gross ||
      withheld !== ((gross-premium) * BigInt(terms.withholdingBps) / 10_000n) || net !== gross-premium-withheld || net === 0n ||
      stakeLock !== (gross*BigInt(terms.stakeBps)+9_999n)/10_000n ||
      poolReservation !== (terms.poolOnlyAllowed ? gross : gross-stakeLock)) throw new Error('INVALID_TERMS');
}

function snapshotTerms(terms: Terms): Terms {
  validateTerms(terms);
  return Object.freeze({ ...terms });
}

function expectedExtra(t: Terms, requestHash: Hex) {
  return {
    profile: PROFILE, assetTransferMethod: TRANSFER_METHOD, paymentFlow: PAYMENT_FLOW,
    name: t.tokenName, version: t.tokenVersion, providerId: t.providerId, policyId: t.policyId,
    policyHash: t.policyHash, requestHash, providerOwner: t.providerOwner.toLowerCase(), providerPayout: t.providerPayout.toLowerCase(),
    premiumBps: t.premiumBps, stakeBps: t.stakeBps, withholdingBps: t.withholdingBps, duration: t.duration,
    poolOnlyAllowed: t.poolOnlyAllowed, gross: t.gross, premium: t.premium, withheld: t.withheld,
    providerNet: t.net, stakeLock: t.stakeLock, poolReservation: t.poolReservation,
  };
}

export function requirementsFor(terms: Terms, requestHash: Hex): PaymentRequirements {
  validateTerms(terms); bytes32(requestHash, 'request_hash');
  return {
    scheme: SCHEME, network: NETWORK, asset: terms.token.toLowerCase() as Address,
    amount: terms.gross, payTo: terms.core.toLowerCase() as Address, maxTimeoutSeconds: 300,
    extra: expectedExtra(terms, requestHash),
  } as PaymentRequirements;
}

function validateRequirements(input: unknown, terms: Terms, requestHash: Hex): PaymentRequirements {
  const expected = requirementsFor(terms, requestHash);
  const actual = exactKeys(input, ['scheme','network','asset','amount','payTo','maxTimeoutSeconds','extra']);
  const extra = exactKeys(actual.extra, TERM_EXTRA_KEYS);
  if (actual.scheme !== expected.scheme || actual.network !== expected.network || actual.asset !== expected.asset ||
      actual.amount !== expected.amount || actual.payTo !== expected.payTo || actual.maxTimeoutSeconds !== 300 ||
      TERM_EXTRA_KEYS.some(k => extra[k] !== (expected.extra as Record<string, unknown>)[k])) throw new Error('INVALID_REQUIREMENTS');
  return expected;
}

function validatePaymentRoot(input: unknown): Record<string, any> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype,null].includes(Object.getPrototypeOf(input))) throw new Error('INVALID_PAYMENT');
  const raw = input as Record<string, any>;
  const allowed = ['x402Version','accepted','payload','resource','extensions'];
  if (Object.keys(raw).some(k => !allowed.includes(k)) || ['x402Version','accepted','payload'].some(k => !Object.hasOwn(raw,k))) throw new Error('INVALID_PAYMENT');
  if (Object.hasOwn(raw,'resource') && raw.resource != null) {
    const resource = exactKeys(raw.resource, ['url','description','mimeType','serviceName','tags','iconUrl'].filter(k => Object.hasOwn(raw.resource,k)));
    if (typeof resource.url !== 'string') throw new Error('INVALID_PAYMENT');
    canonicalRequestUrl(resource.url);
    if (resource.description !== undefined && typeof resource.description !== 'string' || resource.mimeType !== undefined && typeof resource.mimeType !== 'string' ||
        resource.serviceName !== undefined && typeof resource.serviceName !== 'string' || resource.iconUrl !== undefined && typeof resource.iconUrl !== 'string' ||
        resource.tags !== undefined && (!Array.isArray(resource.tags) || resource.tags.some((tag: unknown) => typeof tag !== 'string'))) throw new Error('INVALID_PAYMENT');
  }
  if (Object.hasOwn(raw,'extensions') && raw.extensions != null &&
      (!raw.extensions || typeof raw.extensions !== 'object' || Array.isArray(raw.extensions) || Object.keys(raw.extensions).length !== 0)) throw new Error('INVALID_PAYMENT');
  return raw;
}

function validateIntent(input: unknown, terms: Terms, requestHash: Hex, nowSeconds: bigint, allowExpired = false): Intent {
  const raw = exactKeys(input, INTENT_KEYS);
  const intent: Intent = {
    chainId: raw.chainId, core: addr(raw.core,'core'), token: addr(raw.token,'token'), payer: addr(raw.payer,'payer'),
    providerId: bytes32(raw.providerId,'provider_id'), policyId: bytes32(raw.policyId,'policy_id'), policyHash: bytes32(raw.policyHash,'policy_hash'),
    requestHash: bytes32(raw.requestHash,'request_hash'), gross: raw.gross, payerSalt: bytes32(raw.payerSalt,'payer_salt'),
    validAfter: raw.validAfter, validBefore: raw.validBefore,
  };
  const after = uint(intent.validAfter, 'valid_after'); const before = uint(intent.validBefore, 'valid_before');
  if (uint(intent.chainId,'chain_id') !== 84532n || intent.core !== terms.core.toLowerCase() || intent.token !== terms.token.toLowerCase() ||
      intent.providerId !== terms.providerId || intent.policyId !== terms.policyId || intent.policyHash !== terms.policyHash ||
      intent.requestHash !== requestHash || uint(intent.gross,'gross') !== uint(terms.gross,'gross') || after === 0n ||
      before <= after || before - after > MAX_AUTHORIZATION_SECONDS || nowSeconds < 0n ||
      (!allowExpired && !(after < nowSeconds && nowSeconds < before))) throw new Error('INVALID_INTENT');
  return Object.freeze(intent);
}

export function hashIntent(intent: Intent): Hex {
  const typeHash = keccak256(toBytes(INTENT_LITERAL));
  return keccak256(encodeAbiParameters(
    [{type:'bytes32'},{type:'uint256'},{type:'address'},{type:'address'},{type:'address'},{type:'bytes32'},{type:'bytes32'},{type:'bytes32'},{type:'bytes32'},{type:'uint256'},{type:'bytes32'},{type:'uint256'},{type:'uint256'}],
    [typeHash,BigInt(intent.chainId),intent.core,intent.token,intent.payer,intent.providerId,intent.policyId,intent.policyHash,intent.requestHash,BigInt(intent.gross),intent.payerSalt,BigInt(intent.validAfter),BigInt(intent.validBefore)],
  ));
}

function receiveTypedData(intent: Intent, intentHash: Hex, terms: Terms) {
  return {
    domain: { name: terms.tokenName, version: terms.tokenVersion, chainId: 84532, verifyingContract: terms.token },
    types: { ReceiveWithAuthorization: [
      {name:'from',type:'address'},{name:'to',type:'address'},{name:'value',type:'uint256'},
      {name:'validAfter',type:'uint256'},{name:'validBefore',type:'uint256'},{name:'nonce',type:'bytes32'},
    ] }, primaryType: 'ReceiveWithAuthorization' as const,
    message: { from:intent.payer,to:intent.core,value:BigInt(intent.gross),validAfter:BigInt(intent.validAfter),validBefore:BigInt(intent.validBefore),nonce:intentHash },
  };
}
function splitSignature(signature: Hex) {
  if (!/^0x[0-9a-f]{130}$/.test(signature)) throw new Error('INVALID_SIGNATURE');
  const r = `0x${signature.slice(2,66)}` as Hex; const s = `0x${signature.slice(66,130)}` as Hex; let v = Number.parseInt(signature.slice(130,132),16);
  if (v < 27) v += 27;
  const sNum = BigInt(s); const half = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
  if ((v !== 27 && v !== 28) || sNum === 0n || sNum > half) throw new Error('INVALID_SIGNATURE');
  return {r,s,v};
}
function encodeCall(intent: Intent, intentHash: Hex, signature: Hex): Hex {
  const {v,r,s} = splitSignature(signature);
  return encodeFunctionData({abi:CORE_ABI,functionName:'settleAssured',args:[{
    chainId:BigInt(intent.chainId),core:intent.core,token:intent.token,payer:intent.payer,providerId:intent.providerId,
    policyId:intent.policyId,policyHash:intent.policyHash,requestHash:intent.requestHash,gross:BigInt(intent.gross),
    payerSalt:intent.payerSalt,validAfter:BigInt(intent.validAfter),validBefore:BigInt(intent.validBefore),
  },v,r,s]});
}

export async function prepareCall(payment: unknown, terms: Terms, requestHash: Hex, nowSeconds: bigint, options: {allowExpired?: boolean} = {}): Promise<PreparedCall> {
  validateTerms(terms);
  const root = validatePaymentRoot(payment);
  if (root.x402Version !== 2) throw new Error('INVALID_PAYMENT');
  validateRequirements(root.accepted, terms, requestHash);
  const payload = exactKeys(root.payload, ['intent','intentHash','signature']);
  const intent = validateIntent(payload.intent, terms, requestHash, nowSeconds, options.allowExpired === true);
  const intentHash = hashIntent(intent);
  if (payload.intentHash !== intentHash || typeof payload.signature !== 'string') throw new Error('INVALID_PAYMENT');
  const signature = payload.signature as Hex;
  splitSignature(signature);
  const recovered = await recoverTypedDataAddress({...receiveTypedData(intent,intentHash,terms),signature});
  if (recovered.toLowerCase() !== intent.payer) throw new Error('INVALID_SIGNATURE');
  return Object.freeze({intent,intentHash,signature,to:terms.core.toLowerCase() as Address,data:encodeCall(intent,intentHash,signature)});
}

export async function validateCall(callInput: unknown, terms: Terms, nowSeconds: bigint, options: {allowExpired?: boolean} = {}): Promise<PreparedCall> {
  validateTerms(terms);
  const raw = exactKeys(callInput, ['intent','intentHash','signature','to','data']);
  const intent = validateIntent(raw.intent, terms, (raw.intent as Intent)?.requestHash, nowSeconds, options.allowExpired === true);
  const hash = hashIntent(intent);
  if (raw.intentHash !== hash || typeof raw.signature !== 'string' || raw.to !== terms.core.toLowerCase()) throw new Error('INVALID_CALL');
  const signature = raw.signature as Hex; splitSignature(signature);
  const recovered = await recoverTypedDataAddress({...receiveTypedData(intent,hash,terms),signature});
  if (recovered.toLowerCase() !== intent.payer) throw new Error('INVALID_SIGNATURE');
  const data = encodeCall(intent,hash,signature);
  if (raw.data !== data) throw new Error('INVALID_CALL');
  return Object.freeze({intent,intentHash:hash,signature,to:terms.core.toLowerCase() as Address,data});
}
export const validatePreparedCall = validateCall;

export type CreatePaymentOptions = { terms: Terms; requestHash: Hex; payer: PayerSigner; nowSeconds: bigint; maxGross: string; createSalt?: () => Hex };
export async function createPayment(options: CreatePaymentOptions): Promise<PaymentPayload> {
  const terms=snapshotTerms(options.terms); const {requestHash,payer}=options; bytes32(requestHash,'request_hash');
  if (typeof options.maxGross !== 'string') throw new Error('INVALID_MAX_GROSS');
  if (uint(terms.gross,'gross') > uint(options.maxGross,'max_gross')) throw new Error('SPEND_CAP_EXCEEDED');
  if (options.nowSeconds <= 1n || typeof payer.signTypedData !== 'function') throw new Error('INVALID_PAYER');
  const salt = (options.createSalt ?? (() => `0x${randomBytes(32).toString('hex')}` as Hex))();
  bytes32(salt,'payer_salt');
  const intent: Intent = Object.freeze({chainId:'84532',core:terms.core.toLowerCase() as Address,token:terms.token.toLowerCase() as Address,payer:payer.address.toLowerCase() as Address,
    providerId:terms.providerId,policyId:terms.policyId,policyHash:terms.policyHash,requestHash,gross:terms.gross,payerSalt:salt,
    validAfter:(options.nowSeconds-1n).toString(),validBefore:(options.nowSeconds+MAX_AUTHORIZATION_SECONDS-1n).toString()});
  const intentHash=hashIntent(intent); const typed=receiveTypedData(intent,intentHash,terms); const signature=await payer.signTypedData(typed);
  const requirements=requirementsFor(terms,requestHash);
  const schemeClient: SchemeNetworkClient = {scheme:SCHEME,async createPaymentPayload(version, req) {
    if (version !== 2) throw new Error('UNSUPPORTED_VERSION');
    validateRequirements(req,terms,requestHash);
    return {x402Version:2,payload:{intent,intentHash,signature}};
  }};
  const client=x402Client.fromConfig({schemes:[{network:NETWORK,client:schemeClient}],spendControls:{allowedAssets:[{network:NETWORK,asset:terms.token.toLowerCase() as Address,maxAmountPerPayment:options.maxGross}]}});
  const required={x402Version:2,accepts:[requirements]} as PaymentRequired;
  const sdkResult=await client.createPaymentPayload(required);
  let result: PaymentPayload;
  try { result=JSON.parse(JSON.stringify(sdkResult)) as PaymentPayload; } catch { throw new Error('INVALID_PAYMENT'); }
  await prepareCall(result,terms,requestHash,options.nowSeconds);
  return result;
}

function registeredServer(terms: Terms, engine: SettlementEngine, requestHash: Hex) {
  const requirements=requirementsFor(terms,requestHash);
  let settledResult: any;
  const facilitatorScheme: SchemeNetworkFacilitator = {
    scheme:SCHEME,caipFamily:'eip155:*',getExtra:()=>expectedExtra(terms,requestHash),getSigners:()=>[],
    async verify(payload, req) { try { validateRequirements(req,terms,requestHash); await prepareCall(payload,terms,requestHash,BigInt(Math.floor(Date.now()/1000))); return {isValid:true,payer:(payload as any).payload.intent.payer}; } catch { return {isValid:false,invalidReason:'INVALID_PAYMENT'}; } },
    async settle(payload, req) {
      try { validateRequirements(req,terms,requestHash); const call=await prepareCall(payload,terms,requestHash,BigInt(Math.floor(Date.now()/1000)),{allowExpired:true}); settledResult=await engine.settle(call);
        return {success:settledResult.state==='confirmed',transaction:settledResult.transaction,network:NETWORK,payer:call.intent.payer,...(settledResult.state==='confirmed'?{}:{errorReason:`ASSUREPAY_${settledResult.state.toUpperCase()}`})};
      } catch { return {success:false,errorReason:'INVALID_PAYMENT',transaction:'',network:NETWORK}; }
    },
  };
  const facilitator=new x402Facilitator().register(NETWORK,facilitatorScheme);
  const serverScheme: SchemeNetworkServer = {
    scheme:SCHEME,defaultAssetTransferMethod:TRANSFER_METHOD,
    paymentFlows:{[TRANSFER_METHOD]:{supported:[PAYMENT_FLOW],default:PAYMENT_FLOW}},
    async parsePrice(price,network) { if(network!==NETWORK || !price || typeof price!=='object' || (price as any).amount!==terms.gross || (price as any).asset!==terms.token.toLowerCase()) throw new Error('INVALID_PRICE'); return {amount:terms.gross,asset:terms.token.toLowerCase() as Address,extra:expectedExtra(terms,requestHash)}; },
    validateFacilitatorSupport(network,kind) { if(network!==NETWORK || kind.scheme!==SCHEME || kind.extra?.profile!==PROFILE || kind.extra.assetTransferMethod!==TRANSFER_METHOD || kind.extra.paymentFlow!==PAYMENT_FLOW) return 'PROFILE_MISMATCH'; },
    async enhancePaymentRequirements(req,kind) { if(kind.scheme!==SCHEME) throw new Error('PROFILE_MISMATCH'); return validateRequirements(req,terms,requestHash); },
  };
  const server=new x402ResourceServer({async getSupported(){const supported=facilitator.getSupported(); return {...supported,kinds:supported.kinds.map(k=>({...k,network:NETWORK}))};},verify:(p,r)=>facilitator.verify(p,r),settle:(p,r)=>facilitator.settle(p,r)}).register(NETWORK,serverScheme);
  return {server,requirements,last:()=>settledResult};
}

export async function createRegisteredServer(terms: Terms, engine: SettlementEngine) {
  const trustedTerms=snapshotTerms(terms);
  const servers=new Map<string,ReturnType<typeof registeredServer>>();
  async function forRequest(requestHash: Hex,url: string) {
    bytes32(requestHash,'request_hash');
    canonicalRequestUrl(url);
    let instance=servers.get(requestHash);
    if(!instance) { instance=registeredServer(trustedTerms,engine,requestHash); await instance.server.initialize(); servers.set(requestHash,instance); }
    return instance;
  }
  return {
    async challenge(requestHash: Hex,url: string): Promise<PaymentRequired> {
      const s=await forRequest(requestHash,url);
      return s.server.createPaymentRequiredResponse([s.requirements],{url,description:'AssurePay protected resource'});
    },
    async settle(payment: unknown,requestHash: Hex) {
      bytes32(requestHash,'request_hash');
      // Each SDK settlement gets a private result slot, so concurrent calls cannot
      // observe another invocation's successful engine result.
      const s=registeredServer(trustedTerms,engine,requestHash);
      await s.server.initialize();
      const result=await s.server.settlePayment(payment as PaymentPayload,s.requirements,undefined,undefined,undefined,'before-handler');
      const detail=s.last();
      if(detail && result?.success === (detail.state === 'confirmed')) return detail;
      return {state:'invalid',transaction:'',coverageId:ZERO32} as const;
    },
    get server(){ return [...servers.values()][0]?.server; },
  };
}
