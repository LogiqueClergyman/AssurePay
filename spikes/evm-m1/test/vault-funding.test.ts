import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { parseTransaction, recoverTransactionAddress, type Address, type Hex } from 'viem';
import { runVaultFunding, FUNDING_TARGET, type FundingClient, type FundingOptions, type FundingReceipt, type FundingSigner, type FundingStore, type FundingTransaction } from '../src/vault-funding.js';

const relayerAccount=privateKeyToAccount(`0x${'11'.repeat(32)}`);
const vaultAccount=privateKeyToAccount(`0x${'22'.repeat(32)}`);
const relayer=relayerAccount.address.toLowerCase() as Address;
const vault=vaultAccount.address.toLowerCase() as Address;
const H=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;

class MemoryStore implements FundingStore {
  session:any; prepared:any[]=[]; confirmations:any[]=[];
  async createFundingSession(_p:string,config:any){this.session={version:1,config,prepared:this.prepared,confirmations:this.confirmations};return this.session;}
  async readFundingSession(){if(!this.session){const e=new Error('missing');(e as any).code='session_unavailable';throw e;}return this.session;}
  async recordFundingPrepared(_p:string,r:any){this.prepared.push(r);return r;}
  async recordFundingConfirmed(_p:string,k:string,c:any){this.confirmations.push({kind:k,confirmation:c});return c;}
}

class FakeChain implements FundingClient {
  chain=84532; block=10n; hash=H(10); balances=new Map<Address,bigint>([[relayer,99_564_892_689_918_374n],[vault,0n]]);
  nonces=new Map<Address,number>([[relayer,3],[vault,0]]); txs=new Map<Hex,FundingTransaction>(); receipts=new Map<Hex,FundingReceipt>();
  history=new Map<bigint,Map<Address,bigint>>([[10n,new Map(this.balances)]]); estimate=10n; signers=new Map<Address,FundingSigner>();
  async getChainId(){return this.chain;}
  async getBalance({address,blockNumber}:{address:Address;blockNumber?:bigint}){return this.history.get(blockNumber??this.block)?.get(address)??this.balances.get(address)??0n;}
  async getCode(){return '0x' as Hex;}
  async getTransactionCount({address,blockTag}:{address:Address;blockTag:'latest'|'pending'}){return this.nonces.get(address)??0;}
  async getBlock(args?:{blockNumber?:bigint}){const n=args?.blockNumber??this.block;return {number:n,hash:H(Number(n)),parentHash:H(Number(n-1n))};}
  async estimateL1FeeUpperBound(){return this.estimate;}
  async sendRawTransaction(serialized:Hex){const parsed=parseTransaction(serialized);const from=(await recoverTransactionAddress({serializedTransaction:serialized as `0x02${string}`})).toLowerCase() as Address;const hash=(await import('viem')).keccak256(serialized);const to=parsed.to!.toLowerCase() as Address;
    const tx:any={type:'eip1559',accessList:[],blockNumber:this.block+1n,blockHash:H(Number(this.block+1n)),hash,chainId:parsed.chainId,nonce:parsed.nonce,from,to,value:parsed.value,data:parsed.data,gas:parsed.gas,maxFeePerGas:parsed.maxFeePerGas,maxPriorityFeePerGas:parsed.maxPriorityFeePerGas,serialized};this.txs.set(hash,tx);
    const value=parsed.value??0n;const fee=21_000n*2_000_000n;this.balances.set(from,(this.balances.get(from)??0n)-value-fee);this.balances.set(to,(this.balances.get(to)??0n)+value);this.nonces.set(from,(this.nonces.get(from)??0)+1);this.block++;this.history.set(this.block,new Map(this.balances));this.hash=H(Number(this.block));
    const receipt:FundingReceipt={transactionHash:hash,status:'success',blockNumber:this.block,blockHash:this.hash,from,to,gasUsed:21_000n,effectiveGasPrice:2_000_000n};this.receipts.set(hash,receipt);return hash;}
  async getTransactionReceipt(hash:Hex){return this.receipts.get(hash)??null;}
  async getTransaction(hash:Hex){return this.txs.get(hash)??null;}
}
const signer=(account:typeof relayerAccount):FundingSigner=>({address:account.address.toLowerCase() as Address,signTransaction:tx=>account.signTransaction(tx as never)});
function setup(chain=new FakeChain(),store=new MemoryStore(),execute=true):{options:FundingOptions;chain:FakeChain;store:MemoryStore}{return {chain,store,options:{client:chain,relayer:signer(relayerAccount),vault:signer(vaultAccount),journalPath:'/memory/funding',execute,store,wait:async()=>{},expectedRelayer:relayer,expectedVault:vault}};}

test('normalizes excess to exactly the approved relayer balance with two journaled transfers',async()=>{
  const {options,chain,store}=setup();const result=await runVaultFunding(options);
  assert.equal(result.state,'complete');assert.equal(result.relayerBalanceWei,FUNDING_TARGET.toString());assert.equal(result.transactions.length,2);
  assert.equal(store.prepared[0].kind,'excess');assert.equal(store.prepared[0].from,relayer);assert.equal(store.prepared[0].to,vault);
  assert.equal(store.prepared[1].kind,'top-up');assert.equal(store.prepared[1].from,vault);assert.equal(store.prepared[1].to,relayer);
  assert.equal(await chain.getBalance({address:relayer}),FUNDING_TARGET);
  assert.equal(store.confirmations.length,2);
});

test('rejects an excessive L1 estimate before signing, journaling or broadcasting',async()=>{
  const chain=new FakeChain();chain.estimate=100_000_000_000_001n;let signCount=0;const s=setup(chain);s.options.relayer={...s.options.relayer,signTransaction:async()=>{signCount++;throw new Error('should not sign');}};
  await assert.rejects(runVaultFunding(s.options),/M1_VAULT_FUNDING_L1_FEE_ESTIMATE/);
  assert.equal(signCount,0);assert.equal(s.store.prepared.length,0);assert.equal(chain.txs.size,0);
});

test('check mode never signs or broadcasts and reports the exact excess as execute-only work',async()=>{
  const s=setup(new FakeChain(),new MemoryStore(),false);let signCount=0;s.options.relayer={...s.options.relayer,signTransaction:async()=>{signCount++;throw new Error();}};
  const result=await runVaultFunding(s.options);assert.equal(result.state,'ready');assert.equal(result.code,'NO_JOURNAL');assert.equal(signCount,0);assert.equal(s.chain.txs.size,0);
});


test('unrelated relayer nonce after excess confirmation blocks the top-up',async()=>{
  const s=setup();const send=s.chain.sendRawTransaction.bind(s.chain);
  s.chain.sendRawTransaction=async raw=>{const hash=await send(raw);s.chain.nonces.set(relayer,(s.chain.nonces.get(relayer)??0)+1);return hash;};
  await assert.rejects(runVaultFunding(s.options),/M1_VAULT_FUNDING_UNRELATED_ACCOUNT_USE/);
  assert.equal(s.chain.txs.size,1);assert.equal(s.store.prepared.length,1);
});
