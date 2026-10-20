import { keccak256, recoverTypedDataAddress, toBytes, type Address, type Hex } from 'viem';
import type { ReceiptMessage, SignedReceipt, Terms } from './types.js';

export const RESPONSE_TYPE_LITERAL = 'AssuredResponseV1(uint256 chainId,address core,bytes32 coverageId,bytes32 requestHash,bytes32 responseHash,uint16 status,uint256 completedAt)' as const;
const MESSAGE_KEYS = ['chainId','core','coverageId','requestHash','responseHash','status','completedAt'] as const;
const HEX32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

export interface ReceiptSigner { address: Address; signTypedData(data: any): Promise<Hex> }
export interface ReceiptExpectation { terms: Terms; requestHash: Hex; response: Uint8Array; status: number; coverageId?: Hex }

function messageObject(value: unknown): ReceiptMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new Error('INVALID_RECEIPT');
  const m=value as Record<string,unknown>;
  if(Object.keys(m).length!==MESSAGE_KEYS.length || MESSAGE_KEYS.some(k=>!Object.hasOwn(m,k))) throw new Error('INVALID_RECEIPT');
  if(typeof m.chainId!=='string' || m.chainId.length > 78 || !DECIMAL.test(m.chainId) || BigInt(m.chainId)!==84532n ||
    typeof m.core!=='string' || !ADDRESS.test(m.core) || typeof m.coverageId!=='string' || !HEX32.test(m.coverageId) ||
    m.coverageId === `0x${'0'.repeat(64)}` || typeof m.requestHash!=='string' || !HEX32.test(m.requestHash) || m.requestHash === `0x${'0'.repeat(64)}` ||
    typeof m.responseHash!=='string' || !HEX32.test(m.responseHash) || m.responseHash === `0x${'0'.repeat(64)}` ||
    !Number.isInteger(m.status) || (m.status as number)<200 || (m.status as number)>599 ||
    typeof m.completedAt!=='string' || m.completedAt.length > 78 || !DECIMAL.test(m.completedAt) || BigInt(m.completedAt)>=(1n<<256n)) throw new Error('INVALID_RECEIPT');
  return { ...m, core: (m.core as string).toLowerCase() } as unknown as ReceiptMessage;
}

function validAddress(value: unknown): value is Address {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && value.toLowerCase() !== `0x${'0'.repeat(40)}`;
}

export function responseTypedData(messageInput: ReceiptMessage) {
  const message=messageObject(messageInput);
  return {
    domain:{name:'AssurePayResponse',version:'1',chainId:84532,verifyingContract:message.core},
    types:{AssuredResponseV1:[
      {name:'chainId',type:'uint256'},{name:'core',type:'address'},{name:'coverageId',type:'bytes32'},
      {name:'requestHash',type:'bytes32'},{name:'responseHash',type:'bytes32'},{name:'status',type:'uint16'},{name:'completedAt',type:'uint256'},
    ]},primaryType:'AssuredResponseV1' as const,
    message:{chainId:BigInt(message.chainId),core:message.core,coverageId:message.coverageId,requestHash:message.requestHash,responseHash:message.responseHash,status:message.status,completedAt:BigInt(message.completedAt)},
  };
}

export async function signReceipt(messageInput: ReceiptMessage, signer: ReceiptSigner): Promise<SignedReceipt> {
  const message=messageObject(messageInput);
  if(!signer || !validAddress(signer.address) || typeof signer.signTypedData !== 'function') throw new Error('INVALID_RECEIPT_SIGNER');
  const signerAddress=signer.address.toLowerCase();
  const signature=await signer.signTypedData(responseTypedData(message));
  if(typeof signature!=='string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('INVALID_RECEIPT_SIGNATURE');
  try {
    const recovered=await recoverTypedDataAddress({...responseTypedData(message),signature:signature as Hex});
    if(recovered.toLowerCase()!==signerAddress) throw new Error('INVALID_RECEIPT_SIGNATURE');
  } catch { throw new Error('INVALID_RECEIPT_SIGNATURE'); }
  return Object.freeze({message:Object.freeze({...message}),signature});
}

export async function verifyReceipt(receiptInput: unknown, expected: ReceiptExpectation): Promise<boolean> {
  try {
    const expectedCore=expected.terms.core.toLowerCase();
    const expectedOwner=expected.terms.providerOwner.toLowerCase();
    const expectedRequestHash=expected.requestHash;
    const expectedResponseHash=keccak256(expected.response);
    const expectedStatus=expected.status;
    const expectedCoverageId=expected.coverageId;
    if(!receiptInput || typeof receiptInput!=='object' || Array.isArray(receiptInput) || ![Object.prototype,null].includes(Object.getPrototypeOf(receiptInput))) return false;
    const outer=receiptInput as Record<string,unknown>;
    if(Object.keys(outer).length!==2 || !Object.hasOwn(outer,'message') || !Object.hasOwn(outer,'signature') || typeof outer.signature!=='string' || !/^0x[0-9a-fA-F]{130}$/.test(outer.signature)) return false;
    const m=messageObject(outer.message);
    if(m.chainId!=='84532' || m.core.toLowerCase()!==expectedCore || m.requestHash!==expectedRequestHash ||
      m.responseHash!==expectedResponseHash || m.status!==expectedStatus || (expectedCoverageId && m.coverageId!==expectedCoverageId)) return false;
    const recovered=await recoverTypedDataAddress({...responseTypedData(m),signature:outer.signature as Hex});
    return recovered.toLowerCase()===expectedOwner;
  } catch { return false; }
}

export function makeReceiptMessage(input: {terms:Terms;coverageId:Hex;requestHash:Hex;response:Uint8Array;status:number;completedAt:bigint}): ReceiptMessage {
  if(input.completedAt<0n || input.completedAt>=(1n<<256n) || input.response.byteLength>65_536) throw new Error('INVALID_RECEIPT');
  return messageObject({chainId:'84532',core:input.terms.core.toLowerCase(),coverageId:input.coverageId,requestHash:input.requestHash,responseHash:keccak256(input.response),status:input.status,completedAt:input.completedAt.toString()});
}
