import {
  createPublicClient, http,
  keccak256, parseTransaction, recoverTransactionAddress,
  type Address, type Hex, type LocalAccount,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import {
  createFundingSession, readFundingSession, recordFundingPrepared, recordFundingConfirmed,
} from './vault-storage.js';

export const FUNDING_TARGET = 410_000_000_000_000n;
export const FUNDING_GAS = 21_000n;
export const FUNDING_MAX_FEE = 100_000_000n;
export const FUNDING_PRIORITY_FEE = 1_000_000n;
export const FUNDING_MAX_L1_FEE = 100_000_000_000_000n;
export const BASE_FEE_ORACLE = '0x420000000000000000000000000000000000000F' as Address;
const oracleAbi = [{type:'function',name:'getL1FeeUpperBound',stateMutability:'view',inputs:[{name:'serializedSize',type:'uint256'}],outputs:[{name:'fee',type:'uint256'}]}] as const;

export type FundingStep = 'excess' | 'top-up';
export interface FundingTransaction {
  hash: Hex; chainId: number; nonce: number; from: Address; to: Address; value: bigint; data: Hex;
  gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; serialized: Hex;
  type: string; accessList?: readonly unknown[]; blockNumber: bigint | null; blockHash: Hex | null;
}
export interface FundingReceipt {
  transactionHash: Hex; status: 'success'|'reverted'; blockNumber: bigint; blockHash: Hex;
  from: Address; to: Address; gasUsed: bigint; effectiveGasPrice: bigint;
}
export interface FundingClient {
  getChainId(): Promise<number>;
  getBalance(args:{address:Address; blockNumber?:bigint}):Promise<bigint>;
  getCode(args:{address:Address; blockNumber?:bigint}):Promise<Hex|undefined>;
  getTransactionCount(args:{address:Address; blockTag:'latest'|'pending'}):Promise<number>;
  getBlock(args?:{blockNumber?:bigint}):Promise<{number:bigint|null;hash:Hex|null;parentHash?:Hex|null}>;
  estimateL1FeeUpperBound(serializedSize:bigint):Promise<bigint>;
  sendRawTransaction(serialized:Hex):Promise<Hex>;
  getTransactionReceipt(hash:Hex):Promise<FundingReceipt|null>;
  getTransaction(hash:Hex):Promise<FundingTransaction|null>;
}
export interface FundingSigner { address:Address; signTransaction(tx:{chainId:84532;nonce:number;to:Address;value:bigint;data:Hex;gas:bigint;maxFeePerGas:bigint;maxPriorityFeePerGas:bigint;type:'eip1559'}):Promise<Hex>; }
export interface FundingStore {
  createFundingSession(path:string, config:{chainId:84532;relayer:Address;vault:Address;targetWei:'410000000000000'}):Promise<any>;
  readFundingSession(path:string):Promise<any>;
  recordFundingPrepared(path:string,input:{kind:FundingStep;transactionHash:Hex;from:Address;to:Address;nonce:string;valueWei:string;gas:'21000';maxFeePerGasWei:'100000000';maxPriorityFeePerGasWei:'1000000';chainId:84532;calldata:'0x'}):Promise<any>;
  recordFundingConfirmed(path:string,kind:FundingStep,confirmation:{transactionHash:Hex;blockNumber:string;blockHash:Hex;status:'success'}):Promise<any>;
}
export interface FundingOptions {
  client:FundingClient; relayer:FundingSigner; vault:FundingSigner; journalPath:string; execute:boolean;
  store?:FundingStore; wait?: (ms:number)=>Promise<void>; pollAttempts?:number; pollDelayMs?:number;
  expectedRelayer?:Address; expectedVault?:Address;
}
export interface FundingSummary { readonly mode:'check'|'execute'; readonly state:'ready'|'complete'|'pending'|'blocked'; readonly relayer:Address; readonly vault:Address; readonly relayerBalanceWei:string; readonly vaultBalanceWei:string; readonly transactions:readonly Hex[]; readonly code:string; }

const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const okCode=(code:Hex|undefined)=>!code||code==='0x';
function fail(code:string):never{ throw new Error(`M1_VAULT_FUNDING_${code}`); }
function safeSummary(mode:FundingSummary['mode'],state:FundingSummary['state'],relayer:Address,vault:Address,rb:bigint,vb:bigint,txs:Hex[],code:string):FundingSummary {
  return Object.freeze({mode,state,relayer,vault,relayerBalanceWei:rb.toString(),vaultBalanceWei:vb.toString(),transactions:Object.freeze([...txs]),code});
}

/** Performs the exact two-transfer normalization, or checks the same public state without a signer. */
export async function runVaultFunding(options:FundingOptions):Promise<FundingSummary>{
  const {client,relayer,vault,journalPath,execute}=options;
  const store=options.store ?? {createFundingSession,readFundingSession,recordFundingPrepared,recordFundingConfirmed};
  const attempts=options.pollAttempts ?? 20, delay=options.pollDelayMs ?? 5_000;
  if(!Number.isSafeInteger(attempts)||attempts<1||attempts>20||!Number.isSafeInteger(delay)||delay<0||delay>5_000) fail('POLL_BOUND');
  const ra=relayer.address.toLowerCase() as Address, va=vault.address.toLowerCase() as Address;
  if(ra===va||options.expectedRelayer&&!same(ra,options.expectedRelayer)||options.expectedVault&&!same(va,options.expectedVault)) fail('IDENTITY');
  if(await client.getChainId()!==84532) fail('CHAIN');
  const block=await client.getBlock(); if(block.number===null||block.hash===null) fail('BLOCK');
  const anchored=await client.getBlock({blockNumber:block.number});if(!anchored.hash||!same(anchored.hash,block.hash))fail('BLOCK_REORG');
  const [rc,vc,rb,vb,rn,rp,vn,vp]=await Promise.all([
    client.getCode({address:ra,blockNumber:block.number}),client.getCode({address:va,blockNumber:block.number}),
    client.getBalance({address:ra,blockNumber:block.number}),client.getBalance({address:va,blockNumber:block.number}),
    client.getTransactionCount({address:ra,blockTag:'latest'}),client.getTransactionCount({address:ra,blockTag:'pending'}),
    client.getTransactionCount({address:va,blockTag:'latest'}),client.getTransactionCount({address:va,blockTag:'pending'}),
  ]);
  const anchorAfter=await client.getBlock({blockNumber:block.number});if(!anchorAfter.hash||!same(anchorAfter.hash,block.hash))fail('BLOCK_REORG');
  if(!okCode(rc)||!okCode(vc)) fail('ACCOUNT_CODE');

  let session:any;
  try { session=await store.readFundingSession(journalPath); }
  catch (error) {
    if (!/session_unavailable/i.test(String((error as {code?:unknown})?.code??''))) fail('JOURNAL_UNAVAILABLE');
    if(rn!==rp||vn!==vp)fail('PENDING_NONCE');
    if(vn!==0||vb!==0n)fail('VAULT_NOT_FRESH');
    if(rb<=FUNDING_TARGET)fail('NO_EXCESS');
    if(!execute) return safeSummary('check','ready',ra,va,rb,vb,[],'NO_JOURNAL');
    session=await store.createFundingSession(journalPath,{chainId:84532,relayer:ra,vault:va,targetWei:'410000000000000'});
  }
  const config=session.config;
  if(session.version!==1||config?.chainId!==84532||!same(config.relayer,ra)||!same(config.vault,va)||String(config.targetWei)!==FUNDING_TARGET.toString()) fail('JOURNAL_BINDING');
  const prepared=(kind:FundingStep)=>session.prepared?.find((record:any)=>record.kind===kind);
  const confirmed=(kind:FundingStep)=>session.confirmations?.find((record:any)=>record.kind===kind)?.confirmation;
  const known:Hex[]=[];
  const reconcile=async(kind:FundingStep):Promise<FundingReceipt|undefined>=>{
    const p=prepared(kind); if(!p)return undefined;
    const hash=p.transactionHash as Hex; known.push(hash);
    if(!same(p.from,kind==='excess'?ra:va)||!same(p.to,kind==='excess'?va:ra)) fail('JOURNAL_PREPARED_MISMATCH');
    const receipt=await client.getTransactionReceipt(hash); if(!receipt) return undefined;
    await verifyReceipt(client,receipt,p,kind);
    if(receipt.status!=='success')fail(`${kind.toUpperCase()}_REVERTED`);
    const c=confirmed(kind);
    if(c) {if(c.transactionHash!==hash||c.blockNumber!==receipt.blockNumber.toString()||!same(c.blockHash,receipt.blockHash))fail('JOURNAL_CONFIRMATION_MISMATCH');}
    else if(execute) await store.recordFundingConfirmed(journalPath,kind,{transactionHash:hash,blockNumber:receipt.blockNumber.toString(),blockHash:receipt.blockHash,status:'success'});
    return receipt;
  };
  const existingExcess=await reconcile('excess');
  if(prepared('excess')&&!existingExcess) return safeSummary(execute?'execute':'check','pending',ra,va,rb,vb,known,'EXCESS_PENDING');
  if(existingExcess&&existingExcess.status!=='success') fail('EXCESS_REVERTED');
  if(existingExcess){
    const refreshed=await client.getBlock(); if(refreshed.number===null) fail('BLOCK');
    const currentR=await client.getBalance({address:ra,blockNumber:refreshed.number});
    const currentV=await client.getBalance({address:va,blockNumber:refreshed.number});
    if(prepared('top-up')) {
      const top=await reconcile('top-up');
      if(!top)return safeSummary(execute?'execute':'check','pending',ra,va,currentR,currentV,known,'TOPUP_PENDING');
      if(rn!==rp||vn!==vp||rn!==Number(prepared('excess').nonce)+1||vn!==Number(prepared('top-up').nonce)+1)fail('UNRELATED_ACCOUNT_USE');
      const priorR=await client.getBalance({address:ra,blockNumber:top.blockNumber-1n});
      if(priorR>=FUNDING_TARGET||BigInt(prepared('top-up').valueWei)!==FUNDING_TARGET-priorR)fail('TOPUP_VALUE_MISMATCH');
      const end=await client.getBlock(); if(end.number===null)fail('BLOCK');
      const finalR=await client.getBalance({address:ra,blockNumber:end.number}); const finalV=await client.getBalance({address:va,blockNumber:end.number});
      if(finalR!==FUNDING_TARGET)fail('TARGET_MISMATCH');
      return safeSummary(execute?'execute':'check','complete',ra,va,finalR,finalV,known,'OK');
    }
    if(rn!==rp||vn!==vp||rn!==Number(prepared('excess').nonce)+1||vn!==0)fail('UNRELATED_ACCOUNT_USE');
    const [settledR,settledV]=await Promise.all([client.getBalance({address:ra,blockNumber:existingExcess.blockNumber}),client.getBalance({address:va,blockNumber:existingExcess.blockNumber})]);
    if(currentR!==settledR||currentV!==settledV)fail('BALANCE_CHANGED');
    if(!execute)return safeSummary('check','ready',ra,va,currentR,currentV,known,'TOPUP_REQUIRED');
    if(currentR>=FUNDING_TARGET) fail('NO_SHORTFALL');
    const shortfall=FUNDING_TARGET-currentR;
    return await submitAndFinish(options,store,known,'top-up',va,ra,shortfall,vn,async()=>undefined);
  }
  if(rn!==rp||vn!==vp)fail('PENDING_NONCE');
  if(!execute)return safeSummary('check','ready',ra,va,rb,vb,known,rb>FUNDING_TARGET?'EXCESS_REQUIRES_EXECUTE':'NO_EXCESS');
  if(rb<=FUNDING_TARGET) fail('NO_EXCESS');
  if(vn!==0||vb!==0n)fail('VAULT_NOT_FRESH');
  const value=rb-FUNDING_TARGET;
  return submitAndFinish(options,store,known,'excess',ra,va,value,rn,async()=>{
    const tip=await client.getBlock(); if(tip.number===null)fail('BLOCK');
    const after=await client.getBalance({address:ra,blockNumber:tip.number});
    if(after>=FUNDING_TARGET)fail('SOURCE_NOT_BELOW_TARGET');
    return after;
  });
}

async function submitAndFinish(options:FundingOptions,store:FundingStore,known:Hex[],kind:FundingStep,from:Address,to:Address,value:bigint,nonce:number,afterFirst:()=>Promise<bigint|undefined>):Promise<FundingSummary>{
  from=from.toLowerCase() as Address;to=to.toLowerCase() as Address;
  const {client,journalPath,relayer,vault}=options; const signer=kind==='excess'?relayer:vault;
  if(value<=0n||signer.address.toLowerCase()!==from)fail('VALUE');
  const pending=await client.getTransactionCount({address:from,blockTag:'pending'}); const latest=await client.getTransactionCount({address:from,blockTag:'latest'});
  if(pending!==latest||pending!==nonce)fail('NONCE_CHANGED');
  const parent=await client.getBlock(); if(parent.number===null||parent.hash===null)fail('BLOCK');
  const balance=await client.getBalance({address:from,blockNumber:parent.number});
  const recipientBalance=await client.getBalance({address:to,blockNumber:parent.number});
  const [senderCode,receiverCode]=await Promise.all([client.getCode({address:from,blockNumber:parent.number}),client.getCode({address:to,blockNumber:parent.number})]);
  if(!okCode(senderCode)||!okCode(receiverCode))fail('ACCOUNT_CODE');
  if(kind==='excess'&&(balance-FUNDING_TARGET!==value||recipientBalance!==0n))fail('BALANCE_CHANGED');
  if(kind==='top-up'&&recipientBalance+value!==FUNDING_TARGET)fail('BALANCE_CHANGED');
  if(balance<value+FUNDING_GAS*FUNDING_MAX_FEE)fail('FEE_BALANCE');
  const estimate=await client.estimateL1FeeUpperBound(160n); if(estimate>FUNDING_MAX_L1_FEE)fail('L1_FEE_ESTIMATE');
  if(balance<value+FUNDING_GAS*FUNDING_MAX_FEE+estimate)fail('FEE_BALANCE');
  const parentAgain=await client.getBlock({blockNumber:parent.number});
  if(!parentAgain.hash||!same(parentAgain.hash,parent.hash))fail('BLOCK_REORG');
  const serialized=await signer.signTransaction({chainId:84532,nonce,to,value,data:'0x',gas:FUNDING_GAS,maxFeePerGas:FUNDING_MAX_FEE,maxPriorityFeePerGas:FUNDING_PRIORITY_FEE,type:'eip1559'});
  const parsed=parseTransaction(serialized);
  if(parsed.type!=='eip1559'||(parsed.accessList?.length??0)!==0||parsed.chainId!==84532||parsed.nonce!==nonce||!parsed.to||!same(parsed.to,to)||parsed.value!==value||(parsed.data??'0x')!=='0x'||parsed.gas!==FUNDING_GAS||parsed.maxFeePerGas!==FUNDING_MAX_FEE||parsed.maxPriorityFeePerGas!==FUNDING_PRIORITY_FEE) fail('SIGNED_FIELDS');
  const recovered=await recoverTransactionAddress({serializedTransaction:serialized as `0x02${string}`});
  if(!same(recovered,from))fail('SIGNED_SENDER');
  const currentHead=await client.getBlock();
  if(currentHead.number===null||currentHead.hash===null)fail('BLOCK');
  const [balanceNow,recipientNow,nonceNow,pendingNow]=await Promise.all([client.getBalance({address:from,blockNumber:currentHead.number}),client.getBalance({address:to,blockNumber:currentHead.number}),client.getTransactionCount({address:from,blockTag:'latest'}),client.getTransactionCount({address:from,blockTag:'pending'})]);
  const currentAgain=await client.getBlock({blockNumber:currentHead.number});
  if(!currentAgain.hash||!same(currentAgain.hash,currentHead.hash)||balanceNow!==balance||recipientNow!==recipientBalance||nonceNow!==nonce||pendingNow!==nonce)fail('STATE_CHANGED');
  const hash=keccak256(serialized); known.push(hash);
  await store.recordFundingPrepared(journalPath,{kind,transactionHash:hash,from,to,nonce:String(nonce),valueWei:value.toString(),gas:'21000',maxFeePerGasWei:'100000000',maxPriorityFeePerGasWei:'1000000',chainId:84532,calldata:'0x'});
  try {const sent=await client.sendRawTransaction(serialized);if(!same(sent,hash)){ /* reconcile only the locally derived hash */ }}catch{ /* durable hash is reconciled below; never replace it */ }
  let receipt:FundingReceipt|null=null;
  for(let i=0;i< (options.pollAttempts??20);i++) { try{receipt=await client.getTransactionReceipt(hash);}catch{receipt=null;} if(receipt)break; if(i+1<(options.pollAttempts??20))await(options.wait??(ms=>new Promise<void>(r=>setTimeout(r,ms))))(options.pollDelayMs??5_000); }
  if(!receipt)return safeSummary('execute','pending',relayer.address,vault.address,await client.getBalance({address:relayer.address}),await client.getBalance({address:vault.address}),known,`${kind.toUpperCase()}_PENDING`);
  const prep={from,to,valueWei:value.toString(),transactionHash:hash,nonce:String(nonce)}; await verifyReceipt(client,receipt,prep,kind);
  if(receipt.status!=='success')fail(`${kind.toUpperCase()}_REVERTED`);
  await store.recordFundingConfirmed(journalPath,kind,{transactionHash:hash,blockNumber:receipt.blockNumber.toString(),blockHash:receipt.blockHash,status:'success'});
  const recorded=await store.readFundingSession(journalPath);
  const excessRecord=recorded.prepared.find((p:any)=>p.kind==='excess');
  const topRecord=recorded.prepared.find((p:any)=>p.kind==='top-up');
  const expectedR=Number(excessRecord.nonce)+1,expectedV=topRecord?Number(topRecord.nonce)+1:0;
  const [rl,rp,vl,vp]=await Promise.all([client.getTransactionCount({address:relayer.address,blockTag:'latest'}),client.getTransactionCount({address:relayer.address,blockTag:'pending'}),client.getTransactionCount({address:vault.address,blockTag:'latest'}),client.getTransactionCount({address:vault.address,blockTag:'pending'})]);
  if(rl!==expectedR||rp!==expectedR||vl!==expectedV||vp!==expectedV)fail('UNRELATED_ACCOUNT_USE');
  const after=await afterFirst();
  if(kind==='excess'){
    const topNonce=await client.getTransactionCount({address:vault.address,blockTag:'latest'});
    const fresh=await client.getBlock(); if(fresh.number===null)fail('BLOCK');
    const rNow=await client.getBalance({address:relayer.address,blockNumber:fresh.number}); const vNow=await client.getBalance({address:vault.address,blockNumber:fresh.number});
    const [settledR,settledV]=await Promise.all([client.getBalance({address:relayer.address,blockNumber:receipt.blockNumber}),client.getBalance({address:vault.address,blockNumber:receipt.blockNumber})]);
    if(rNow!==settledR||vNow!==settledV)fail('BALANCE_CHANGED');
    if(after===undefined||after>=FUNDING_TARGET||rNow!==after||topNonce!==(await client.getTransactionCount({address:vault.address,blockTag:'pending'})))fail('POST_EXCESS_STATE');
    // The top-up is a separately journaled step; execute it once in this invocation.
    return await submitAndFinish(options,store,known,'top-up',vault.address,relayer.address,FUNDING_TARGET-rNow,topNonce,async()=>undefined);
  }
  const tip=await client.getBlock();if(tip.number===null)fail('BLOCK'); const finalR=await client.getBalance({address:relayer.address,blockNumber:tip.number});const finalV=await client.getBalance({address:vault.address,blockNumber:tip.number});
  if(finalR!==FUNDING_TARGET)fail('TARGET_MISMATCH');
  return safeSummary('execute','complete',relayer.address,vault.address,finalR,finalV,known,'OK');
}

async function verifyReceipt(client:FundingClient,r:FundingReceipt,p:any,kind:FundingStep):Promise<void>{
  const hash=(p.transactionHash??p.hash) as Hex; if(!same(r.transactionHash,hash)||!same(r.from,p.from)||!same(r.to,p.to))fail('RECEIPT_IDENTITY');
  const tx=await client.getTransaction(hash);if(!tx||tx.type!=='eip1559'||(tx.accessList?.length??0)!==0||tx.blockNumber!==r.blockNumber||!tx.blockHash||!same(tx.blockHash,r.blockHash)||tx.chainId!==84532||!same(tx.hash,hash)||!same(tx.from,p.from)||!tx.to||!same(tx.to,p.to)||tx.value!==BigInt(p.valueWei??p.value)||(tx.data??'0x')!=='0x'||tx.gas!==FUNDING_GAS||tx.nonce!==Number(p.nonce)||tx.maxFeePerGas!==FUNDING_MAX_FEE||tx.maxPriorityFeePerGas!==FUNDING_PRIORITY_FEE)fail('CANONICAL_TX');
  const canonical=await client.getBlock({blockNumber:r.blockNumber});if(!canonical.hash||!same(canonical.hash,r.blockHash))fail('NONCANONICAL_RECEIPT');
  const parent=await client.getBlock({blockNumber:r.blockNumber-1n});if(!parent.hash||canonical.parentHash&&!same(canonical.parentHash,parent.hash))fail('NONCANONICAL_PARENT');
  if(r.status==='success'){
    const before=r.blockNumber-1n; const fromBefore=await client.getBalance({address:p.from,blockNumber:before}); const toBefore=await client.getBalance({address:p.to,blockNumber:before});
    const fromAfter=await client.getBalance({address:p.from,blockNumber:r.blockNumber}); const toAfter=await client.getBalance({address:p.to,blockNumber:r.blockNumber});
    const canonicalAfter=await client.getBlock({blockNumber:r.blockNumber});if(!canonicalAfter.hash||!same(canonicalAfter.hash,r.blockHash))fail('NONCANONICAL_RECEIPT');
    const parentAfter=await client.getBlock({blockNumber:before});if(!parentAfter.hash||!same(parentAfter.hash,parent.hash))fail('NONCANONICAL_PARENT');
    if(r.gasUsed!==FUNDING_GAS||r.effectiveGasPrice<0n||r.effectiveGasPrice>FUNDING_MAX_FEE)fail('RECEIPT_FEE');
    const value=BigInt(p.valueWei??p.value); const fee=r.gasUsed*r.effectiveGasPrice;
    if(kind==='excess'&&fromBefore-FUNDING_TARGET!==value)fail('EXCESS_VALUE_MISMATCH');
    if(kind==='excess'&&fromAfter>=FUNDING_TARGET)fail('EXCESS_DID_NOT_LEAVE_SOURCE_BELOW_TARGET');
    if(kind==='top-up'&&(toBefore>=FUNDING_TARGET||toBefore+value!==FUNDING_TARGET||toAfter!==FUNDING_TARGET))fail('TOPUP_VALUE_MISMATCH');
    if(toAfter-toBefore!==value)fail('RECEIVER_DELTA');
    if(fromBefore-fromAfter<value+fee||fromBefore-fromAfter>value+fee+FUNDING_MAX_L1_FEE)fail('SENDER_DELTA');
  }
}

/** Production viem adapter. Signers are constructed only by the execute CLI path. */
export function createFundingRpc(rpcUrl:string):FundingClient{
  const c=createPublicClient({chain:baseSepolia,cacheTime:0,transport:http(rpcUrl,{retryCount:0})});
  return {
    getChainId:()=>c.getChainId(),getBalance:a=>c.getBalance(a),getCode:a=>c.getCode(a),getTransactionCount:a=>c.getTransactionCount(a),getBlock:async a=>{const b=await c.getBlock(a);return {number:b.number,hash:b.hash,parentHash:b.parentHash};},
    estimateL1FeeUpperBound:async(size)=>{const code=await c.getCode({address:BASE_FEE_ORACLE});if(!code||code==='0x')fail('ORACLE_CODE');return c.readContract({address:BASE_FEE_ORACLE,abi:oracleAbi,functionName:'getL1FeeUpperBound',args:[size]});},
    sendRawTransaction:serialized=>c.sendRawTransaction({serializedTransaction:serialized}),
    getTransactionReceipt:async hash=>{try{const r=await c.getTransactionReceipt({hash});return {transactionHash:r.transactionHash,status:r.status,blockNumber:r.blockNumber,blockHash:r.blockHash,from:r.from,to:r.to??BASE_FEE_ORACLE,gasUsed:r.gasUsed,effectiveGasPrice:r.effectiveGasPrice??0n};}catch{return null;}},
    getTransaction:async hash=>{try{const t=await c.getTransaction({hash});return {...t,chainId:(t as {chainId?:number}).chainId??0,hash:t.hash,from:t.from,to:t.to??BASE_FEE_ORACLE,value:t.value,data:t.input,gas:t.gas,maxFeePerGas:t.maxFeePerGas??0n,maxPriorityFeePerGas:t.maxPriorityFeePerGas??0n,serialized:'0x' as Hex};}catch{return null;}},
  } as FundingClient;
}

export function createFundingSigner(account:LocalAccount):FundingSigner{return {address:account.address,signTransaction:tx=>account.signTransaction(tx as never)};}
