import {
  decodeEventLog, decodeFunctionData, encodeDeployData, encodeFunctionData, getContractAddress,
  keccak256, parseAbi, recoverTypedDataAddress, type Address, type Hex,
} from 'viem';
import { verifySettlement, readTerms } from '../../x402-assurance/src/chain.js';
import { hashIntent } from '../../x402-assurance/src/protocol.js';
import { CORE_ABI } from '../../x402-assurance/src/core-abi.js';
import { ECONOMICS, GAS_CAPS, STEP_ORDER, stepActor, validateConfig } from './plan.js';
import { requestHashFor, rollbackRequestHashFor } from './fixtures.js';
import type { CampaignManifest, StepKind, TransactionRecord, VerificationReport, VerifiedTransaction } from './types.js';

const PUBLIC_USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e' as Address;
const ZERO = `0x${'00'.repeat(32)}` as Hex;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const TOKEN_ABI = parseAbi([
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function authorizationState(address,bytes32) view returns (bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'event Approval(address indexed owner,address indexed spender,uint256 value)',
  'event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)',
]);
const STATE_ABI = parseAbi([
  'function admin() view returns (address)', 'function adjudicator() view returns (address)',
  'function token() view returns (address)', 'function paused() view returns (bool)',
  'function poolAssets() view returns (uint256)', 'function totalPoolReserved() view returns (uint256)',
  'function totalProviderStake() view returns (uint256)', 'function totalLockedStake() view returns (uint256)',
  'function coverageCount() view returns (uint256)', 'function activeCoverageCount() view returns (uint256)',
  'function providers(bytes32) view returns (address owner,address payout,uint256 freeStake,uint256 lockedStake)',
  'function policies(bytes32) view returns (bytes32 providerId,bytes32 policyHash,uint16 premiumBps,uint16 stakeBps,uint16 withholdingBps,uint64 duration,bool poolOnlyAllowed)',
  'function coverages(bytes32) view returns (address payer,bytes32 providerId,bytes32 policyId,bytes32 policyHash,bytes32 requestHash,uint256 gross,uint256 premium,uint256 withheld,uint256 stakeLock,uint256 poolReservation,uint64 openedAt,uint64 expiresAt,bool poolOnlyAllowed,uint8 status,bytes32 evidenceHash,bytes32 decisionHash,uint256 refundAmount,uint8 outcome)',
  'function registerProvider(bytes32,address,address)',
  'function registerPolicy(bytes32,bytes32,uint16,uint16,uint16,uint64,bool)',
  'function depositStake(bytes32,uint256)', 'function fundPool(uint256)', 'function setPaused(bool)',
  'function settleAssured((uint256 chainId,address core,address token,address payer,bytes32 providerId,bytes32 policyId,bytes32 policyHash,bytes32 requestHash,uint256 gross,bytes32 payerSalt,uint256 validAfter,uint256 validBefore) intent,uint8 v,bytes32 r,bytes32 s)',
  'function fileClaim(bytes32,bytes32)', 'function finalizeClaim(bytes32,uint8,uint256,bytes32)',
  'event ProviderRegistered(bytes32 indexed providerId,address indexed owner,address indexed payout)',
  'event PolicyRegistered(bytes32 indexed policyId,bytes32 indexed providerId,bytes32 policyHash,uint16 premiumBps,uint16 stakeBps,uint16 withholdingBps,uint64 duration,bool poolOnlyAllowed)',
  'event StakeDeposited(bytes32 indexed providerId,address indexed funder,uint256 amount)',
  'event PoolFunded(address indexed funder,uint256 amount)',
  'event CoverageOpened(bytes32 indexed coverageId,address indexed payer,bytes32 indexed providerId,bytes32 policyId,bytes32 requestHash,uint256 gross,uint256 premium,uint256 withheld,uint256 net,uint256 stakeLock,uint256 poolReservation,uint64 expiresAt)',
  'event ClaimFiled(bytes32 indexed coverageId,address indexed payer,bytes32 evidenceHash)',
  'event ClaimFinalized(bytes32 indexed coverageId,uint8 outcome,uint256 refundAmount,bytes32 decisionHash)',
  'event PauseUpdated(bool paused)',
]);

type Artifact = { abi: any; bytecode: Hex; deployedBytecode: Hex };
type VerifyOptions = { client: any; manifest: CampaignManifest; artifact: Artifact; allowLocalFixture?: boolean };
type Anchor = { kind: StepKind; blockNumber: bigint; blockHash: Hex };
type Snapshot = {
  coreToken: bigint; payer: bigint; payout: bigint;
  poolAssets: bigint; totalPoolReserved: bigint; totalProviderStake: bigint; totalLockedStake: bigint;
  coverageCount: bigint; activeCoverageCount: bigint; freeStake: bigint; lockedStake: bigint; paused: boolean;
};
function fail(code: string): never { throw new Error(code); }
const eq = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const asBig = (v: unknown, code = 'VERIFY_STATE') => typeof v === 'bigint' && v >= 0n ? v : fail(code);
const amount = (v: bigint) => v.toString(10);
const U = (n: string | number) => BigInt(n);
function sameKeys(value: unknown, keys: readonly string[]): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
function address(value: unknown): value is Address { return typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value); }
function hex32(value: unknown): value is Hex { return typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value); }
function parseUnsigned(value: unknown, code = 'VERIFY_MANIFEST'): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78) fail(code);
  const n = BigInt(value); if (n >= 1n << 256n) fail(code); return n;
}
function recordAt(manifest: CampaignManifest, index: number, kind: StepKind): TransactionRecord {
  const r: unknown = manifest.transactions[index];
  const keys = ['kind','transaction','from','to','nonce','calldataHash','gas','maxFeePerGas','maxPriorityFeePerGas','value','attempted','blockNumber','blockHash','status'];
  if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some(k => !keys.includes(k)) ||
      ['kind','transaction','from','to','nonce','calldataHash','gas','maxFeePerGas','maxPriorityFeePerGas','value','attempted'].some(k => !Object.hasOwn(r, k))) fail('VERIFY_MANIFEST');
  const row = r as TransactionRecord;
  if (row.kind !== kind || !hex32(row.transaction) || !address(row.from) || !(row.to === null || address(row.to)) ||
      !hex32(row.calldataHash) || row.value !== '0' || row.attempted !== true ||
      !['success','reverted',undefined].includes(row.status)) fail('VERIFY_MANIFEST');
  parseUnsigned(row.nonce); parseUnsigned(row.gas); parseUnsigned(row.maxFeePerGas); parseUnsigned(row.maxPriorityFeePerGas);
  if ((row.blockNumber === undefined) !== (row.blockHash === undefined) || (row.blockNumber === undefined) !== (row.status === undefined)) fail('VERIFY_MANIFEST');
  if (row.blockNumber !== undefined) { parseUnsigned(row.blockNumber); if (!hex32(row.blockHash)) fail('VERIFY_MANIFEST'); }
  return row;
}
function assertManifest(manifest: CampaignManifest, allowLocalFixture: boolean): void {
  if (!sameKeys(manifest, ['version','config','core','transactions']) || manifest.version !== 1 ||
      !Array.isArray(manifest.transactions) || manifest.transactions.length !== STEP_ORDER.length ||
      !(manifest.core === null || address(manifest.core))) fail('VERIFY_MANIFEST');
  try { validateConfig(manifest.config); } catch { fail('VERIFY_CONFIG'); }
  if (manifest.config.mode === 'local' && !allowLocalFixture) fail('VERIFY_LOCAL_FIXTURE_NOT_ALLOWED');
  if (manifest.config.mode === 'public' && !eq(manifest.config.token, PUBLIC_USDC)) fail('VERIFY_TOKEN');
  for (let i = 0; i < STEP_ORDER.length; i++) {
    const kind = STEP_ORDER[i]!; const row = recordAt(manifest, i, kind);
    if (!eq(row.from, manifest.config.roles[stepActor(kind)]) || parseUnsigned(row.gas) !== GAS_CAPS[kind] ||
        parseUnsigned(row.maxFeePerGas) !== parseUnsigned(manifest.config.maxFeePerGas) ||
        parseUnsigned(row.maxPriorityFeePerGas) !== parseUnsigned(manifest.config.maxPriorityFeePerGas) ||
        parseUnsigned(row.maxPriorityFeePerGas) > parseUnsigned(row.maxFeePerGas)) fail('VERIFY_RECORD_POLICY');
    if (i < STEP_ORDER.length - 1 && row.status !== 'success') fail('VERIFY_RECORD_STATUS');
    if (i === STEP_ORDER.length - 1 && row.status !== 'reverted') fail('VERIFY_RECORD_STATUS');
  }
}
function expectArgs(actual: readonly unknown[] | undefined, expected: readonly unknown[], code = 'VERIFY_CALL'): void {
  if (!actual || actual.length !== expected.length || actual.some((v, i) => {
    const e = expected[i];
    return typeof v === 'bigint' || typeof e === 'bigint' ?
      (typeof v === 'number' && Number.isSafeInteger(v) && typeof e === 'bigint' ? BigInt(v) !== e :
        typeof e === 'number' && Number.isSafeInteger(e) && typeof v === 'bigint' ? v !== BigInt(e) : v !== e) :
      typeof v === 'boolean' || typeof e === 'boolean' ? v !== e :
      typeof v === 'string' && typeof e === 'string' ? v.toLowerCase() !== e.toLowerCase() : v !== e;
  })) fail(code);
}
function intentFromDecoded(decoded: any): any {
  const x = decoded.args?.[0];
  if (!x || typeof x !== 'object') fail('VERIFY_INTENT');
  return { chainId: String(x.chainId), core: String(x.core).toLowerCase() as Address, token: String(x.token).toLowerCase() as Address,
    payer: String(x.payer).toLowerCase() as Address, providerId: x.providerId as Hex, policyId: x.policyId as Hex,
    policyHash: x.policyHash as Hex, requestHash: x.requestHash as Hex, gross: String(x.gross), payerSalt: x.payerSalt as Hex,
    validAfter: String(x.validAfter), validBefore: String(x.validBefore) };
}
function signatureFromArgs(decoded: any): Hex {
  const v = Number(decoded.args?.[1]); const r = decoded.args?.[2]; const s = decoded.args?.[3];
  if (!Number.isInteger(v) || (v !== 27 && v !== 28) || typeof r !== 'string' || !/^0x[0-9a-f]{64}$/.test(r) ||
      typeof s !== 'string' || !/^0x[0-9a-f]{64}$/.test(s)) fail('VERIFY_SIGNATURE');
  // Reassembled only in memory. Never include this value in an error or report.
  return `0x${r.slice(2)}${s.slice(2)}${v.toString(16).padStart(2,'0')}` as Hex;
}
async function receiveSignature(intent: any, intentHash: Hex, signature: Hex, expectedPayer: Address): Promise<void> {
  const recovered = await recoverTypedDataAddress({
    domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: intent.token },
    types: { ReceiveWithAuthorization: [
      {name:'from',type:'address'},{name:'to',type:'address'},{name:'value',type:'uint256'},
      {name:'validAfter',type:'uint256'},{name:'validBefore',type:'uint256'},{name:'nonce',type:'bytes32'},
    ] }, primaryType: 'ReceiveWithAuthorization',
    message: { from:intent.payer,to:intent.core,value:BigInt(intent.gross),validAfter:BigInt(intent.validAfter),validBefore:BigInt(intent.validBefore),nonce:intentHash },
    signature,
  });
  if (!eq(recovered, expectedPayer)) fail('VERIFY_SIGNATURE');
}
function decodeCall(data: Hex): any {
  try { return decodeFunctionData({ abi: [...STATE_ABI, ...CORE_ABI], data }); } catch { return fail('VERIFY_CALL'); }
}
function runtimeMatches(template: Hex, deployed: Hex, immutableAddresses: Address[]): boolean {
  if (!/^0x[0-9a-f]+$/i.test(template) || !/^0x[0-9a-f]+$/i.test(deployed) || template.length !== deployed.length) return false;
  const expected = template.slice(2).toLowerCase(); const actual = deployed.slice(2).toLowerCase();
  const maskWords = new Set<string>(immutableAddresses.map(a => a.slice(2).toLowerCase().padStart(64, '0')));
  const masked = new Uint8Array(expected.length / 2);
  let referenceCount = 0;
  // solc immutable references can start at an arbitrary byte offset in PUSH data.
  for (let offset = 0; offset + 32 <= expected.length / 2; offset++) {
    const start = offset * 2; const end = start + 64;
    if (expected.slice(start, end) === '0'.repeat(64) && maskWords.has(actual.slice(start, end))) {
      for (let i = offset; i < offset + 32; i++) masked[i] = 1;
      referenceCount++;
      offset += 31;
    }
  }
  for (let i = 0; i < expected.length / 2; i++) {
    if (!masked[i] && expected.slice(i * 2, i * 2 + 2) !== actual.slice(i * 2, i * 2 + 2)) return false;
  }
  return referenceCount > 0;
}

async function rawFee(client: any, transaction: Hex, blockHash: Hex, blockNumber: bigint, status: 'success'|'reverted'): Promise<{l1: string; operator: string}> {
  try {
    const raw = await client.request({ method: 'eth_getTransactionReceipt', params: [transaction] });
    if (!raw || typeof raw !== 'object' || typeof raw.transactionHash !== 'string' || !eq(raw.transactionHash, transaction) ||
        typeof raw.blockHash !== 'string' || !eq(raw.blockHash, blockHash) || typeof raw.blockNumber !== 'string' ||
        !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(raw.blockNumber) || BigInt(raw.blockNumber) !== blockNumber ||
        raw.status !== (status === 'success' ? '0x1' : '0x0')) return { l1: 'unavailable', operator: 'unavailable' };
    const quantity = (v: unknown) => v === undefined || v === null ? 'unavailable' :
      typeof v === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(v) ? BigInt(v).toString(10) : 'unavailable';
    return { l1: quantity(raw.l1Fee), operator: quantity(raw.operatorFee) };
  } catch { return { l1: 'unavailable', operator: 'unavailable' }; }
}

async function verify(options: VerifyOptions): Promise<VerificationReport> {
  const { client, manifest, artifact } = options;
  assertManifest(manifest, options.allowLocalFixture === true);
  if (!artifact || !Array.isArray(artifact.abi) || typeof artifact.bytecode !== 'string' || typeof artifact.deployedBytecode !== 'string') fail('VERIFY_ARTIFACT');
  const config = manifest.config; const rows = STEP_ORDER.map((kind, i) => recordAt(manifest, i, kind));
  const local = config.mode === 'local';
  if (await client.getChainId() !== 84532) fail('VERIFY_CHAIN');
  const core = manifest.core;
  if (!core) fail('VERIFY_CORE');
  const addresses = config.roles;
  const anchors: Anchor[] = [];
  const verified: VerifiedTransaction[] = [];
  const txs: any[] = []; const receipts: any[] = [];
  for (let i = 0; i < STEP_ORDER.length; i++) {
    const kind = STEP_ORDER[i]!; const row = rows[i]!;
    const [tx, receipt] = await Promise.all([client.getTransaction({ hash: row.transaction }), client.getTransactionReceipt({ hash: row.transaction })]);
    if (!tx || !receipt || !eq(tx.hash, row.transaction) || !eq(receipt.transactionHash, row.transaction) ||
        !eq(tx.from, row.from) || !eq(tx.to ?? '', row.to ?? '') || tx.value !== 0n || tx.chainId !== 84532 ||
        BigInt(tx.nonce) !== parseUnsigned(row.nonce) || !eq(keccak256(tx.input), row.calldataHash) ||
        tx.gas !== parseUnsigned(row.gas) || tx.maxFeePerGas !== parseUnsigned(row.maxFeePerGas) ||
        tx.maxPriorityFeePerGas !== parseUnsigned(row.maxPriorityFeePerGas) || receipt.status !== row.status ||
        !receipt.blockHash || typeof receipt.blockNumber !== 'bigint' || tx.blockNumber !== receipt.blockNumber || !eq(tx.blockHash, receipt.blockHash) ||
        (row.blockNumber !== undefined && (parseUnsigned(row.blockNumber) !== receipt.blockNumber || !eq(row.blockHash, receipt.blockHash)))) fail('VERIFY_TRANSACTION');
    const header = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (!header?.hash || !eq(header.hash, receipt.blockHash)) fail('VERIFY_CANONICAL');
    if (receipt.gasUsed > parseUnsigned(row.gas) || receipt.effectiveGasPrice > parseUnsigned(row.maxFeePerGas)) fail('VERIFY_FEE_CAP');
    const fees = await rawFee(client, row.transaction, receipt.blockHash, receipt.blockNumber, receipt.status);
    anchors.push({ kind, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash }); txs.push(tx); receipts.push(receipt);
    verified.push({ kind, transaction: row.transaction, blockNumber: amount(receipt.blockNumber), blockHash: receipt.blockHash,
      gasUsed: amount(asBig(receipt.gasUsed)), effectiveGasPrice: amount(asBig(receipt.effectiveGasPrice)),
      executionFeeWei: amount(asBig(receipt.gasUsed) * asBig(receipt.effectiveGasPrice)), l1FeeWei: fees.l1, operatorFeeWei: fees.operator,
      calldataBytes: Math.max(0, (tx.input.length - 2) / 2) });
  }
  const priorNonce=new Map<string,bigint>();
  let priorBlock=-1n; let priorIndex=-1n;
  for(let i=0;i<txs.length;i++){
    const tx=txs[i]!; const row=rows[i]!; const block=anchors[i]!.blockNumber;
    const txIndex=typeof tx.transactionIndex==='bigint'?tx.transactionIndex:
      typeof tx.transactionIndex==='number'&&Number.isSafeInteger(tx.transactionIndex)&&tx.transactionIndex>=0?BigInt(tx.transactionIndex):-1n;
    if(txIndex<0n||block<priorBlock||(block===priorBlock&&txIndex<=priorIndex))fail('VERIFY_STEP_ORDER');
    const prior=priorNonce.get(row.from);
    if(prior!==undefined&&parseUnsigned(row.nonce)!==prior+1n)fail('VERIFY_STEP_NONCE_ORDER');
    priorNonce.set(row.from,parseUnsigned(row.nonce)); priorBlock=block; priorIndex=txIndex;
  }
  const coreIndex = getContractAddress({ from: addresses.relayer, nonce: parseUnsigned(rows[0]!.nonce) });
  if (!eq(core, coreIndex) || !eq(rows[0]!.from, addresses.relayer) || rows[0]!.to !== null || txs[0]!.to !== null || !eq(receipts[0]!.contractAddress, core)) fail('VERIFY_DEPLOYMENT');
  const expectedDeployment = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [config.token, addresses.relayer, addresses.adjudicator] });
  if (!eq(txs[0]!.input, expectedDeployment)) fail('VERIFY_DEPLOYMENT');
  const runtime = await client.getCode({ address: core, blockNumber: anchors[0]!.blockNumber });
  if (!runtime || runtime === '0x' || !runtimeMatches(artifact.deployedBytecode, runtime, [config.token, addresses.relayer, addresses.adjudicator])) fail('VERIFY_RUNTIME');
  const read = async (functionName: string, args: readonly unknown[] = [], blockNumber: bigint) => client.readContract({ address: core, abi: STATE_ABI, functionName, args, blockNumber });
  const tokenAddress = config.token;
  if (!eq(await read('token', [], anchors[0]!.blockNumber), tokenAddress) || !eq(await read('admin', [], anchors[0]!.blockNumber), addresses.relayer) ||
      !eq(await read('adjudicator', [], anchors[0]!.blockNumber), addresses.adjudicator)) fail('VERIFY_DEPLOYMENT_CONFIG');
  const checkCall = (index: number, name: string, args: readonly unknown[], to: Address) => {
    const row = rows[index]!; const tx = txs[index]!;
    if (!eq(tx.to, to)) fail('VERIFY_CALL');
    const d = decodeCall(tx.input);
    if (d.functionName !== name) fail('VERIFY_CALL');
    expectArgs(d.args as readonly unknown[], args);
    if (!eq(encodeFunctionData({ abi: artifact.abi, functionName: name, args: d.args as readonly unknown[] }), tx.input)) fail('VERIFY_CALL');
    return d;
  };
  checkCall(1,'registerProvider',[config.providerId,addresses.provider,addresses.provider],core);
  const policyArgs = [config.policyId,config.providerId,ECONOMICS.premiumBps,ECONOMICS.stakeBps,ECONOMICS.withholdingBps,BigInt(ECONOMICS.duration),ECONOMICS.poolOnlyAllowed] as const;
  checkCall(2,'registerPolicy',policyArgs,core);
  const approveDecoded = (() => { try { return decodeFunctionData({abi:TOKEN_ABI,data:txs[3]!.input}); } catch { return fail('VERIFY_CALL'); } })();
  if (!eq(txs[3]!.to,tokenAddress) || approveDecoded.functionName !== 'approve') fail('VERIFY_CALL');
  expectArgs(approveDecoded.args as readonly unknown[],[core,BigInt(ECONOMICS.approval)]);
  if (!eq(encodeFunctionData({abi:TOKEN_ABI,functionName:'approve',args:approveDecoded.args as readonly [Address,bigint]}),txs[3]!.input)) fail('VERIFY_CALL');
  checkCall(4,'depositStake',[config.providerId,BigInt(ECONOMICS.seedStake)],core);
  checkCall(5,'fundPool',[BigInt(ECONOMICS.seedPool)],core);
  for (const i of [7,8,10,11]) if (!eq(txs[i]!.to,core)) fail('VERIFY_CALL');
  checkCall(12,'setPaused',[true],core);
  const finalDecoded=decodeCall(txs[13]!.input);
  if (!eq(txs[13]!.to,core)||finalDecoded.functionName!=='settleAssured') fail('VERIFY_CALL');
  if (!eq(encodeFunctionData({abi:artifact.abi,functionName:'settleAssured',args:finalDecoded.args as readonly unknown[]}),txs[13]!.input)) fail('VERIFY_CALL');

  const trust={chainId:84532 as const,core,token:tokenAddress,providerId:config.providerId,policyId:config.policyId};
  const terms=await readTerms(client,trust,BigInt(ECONOMICS.gross));
  if (terms.premiumBps!==ECONOMICS.premiumBps||terms.stakeBps!==ECONOMICS.stakeBps||terms.withholdingBps!==ECONOMICS.withholdingBps||
      terms.duration!==String(ECONOMICS.duration)||terms.poolOnlyAllowed!==ECONOMICS.poolOnlyAllowed||
      terms.premium!==ECONOMICS.premium||terms.withheld!==ECONOMICS.withheld||terms.net!==ECONOMICS.net||terms.stakeLock!==ECONOMICS.stakeLock||terms.poolReservation!==ECONOMICS.poolReservation) fail('VERIFY_ECONOMICS');
  const policy=await read('policies',[config.policyId],anchors[2]!.blockNumber) as readonly unknown[];
  expectArgs(policy,[config.providerId,terms.policyHash,BigInt(ECONOMICS.premiumBps),BigInt(ECONOMICS.stakeBps),BigInt(ECONOMICS.withholdingBps),BigInt(ECONOMICS.duration),ECONOMICS.poolOnlyAllowed]);
  const provider=await read('providers',[config.providerId],anchors[1]!.blockNumber) as readonly unknown[];
  expectArgs(provider,[addresses.provider,addresses.provider,0n,0n]);
  const e = (index: number, eventName: string) => {
    const matching = receipts[index]!.logs.filter((l: any) => eq(l.address, index===3 ? tokenAddress : core));
    const decoded = matching.map((log: any) => { try { return decodeEventLog({abi:index===3 ? TOKEN_ABI : STATE_ABI,data:log.data,topics:log.topics}); } catch { return undefined; } }).filter(Boolean);
    return decoded.find((x: any) => x.eventName===eventName);
  };
  if (!e(1,'ProviderRegistered')||!e(2,'PolicyRegistered')||!e(4,'StakeDeposited')||!e(5,'PoolFunded')||!e(12,'PauseUpdated')) fail('VERIFY_EVENT');
  const providerEvent=e(1,'ProviderRegistered') as any;
  expectArgs([providerEvent.args.providerId,providerEvent.args.owner,providerEvent.args.payout],[config.providerId,addresses.provider,addresses.provider]);
  const policyEvent=e(2,'PolicyRegistered') as any;
  expectArgs([policyEvent.args.policyHash,policyEvent.args.premiumBps,policyEvent.args.stakeBps,policyEvent.args.withholdingBps,policyEvent.args.duration,policyEvent.args.poolOnlyAllowed],
    [terms.policyHash,BigInt(ECONOMICS.premiumBps),BigInt(ECONOMICS.stakeBps),BigInt(ECONOMICS.withholdingBps),BigInt(ECONOMICS.duration),true]);
  const stakeEvent=e(4,'StakeDeposited') as any; const poolEvent=e(5,'PoolFunded') as any;
  expectArgs([stakeEvent.args.providerId,stakeEvent.args.funder,stakeEvent.args.amount],[config.providerId,addresses.payer,BigInt(ECONOMICS.seedStake)]);
  expectArgs([poolEvent.args.funder,poolEvent.args.amount],[addresses.payer,BigInt(ECONOMICS.seedPool)]);
  const approvalEvents=receipts[3]!.logs.filter((log:any)=>eq(log.address,tokenAddress)).map((log:any)=>{
    try{return decodeEventLog({abi:TOKEN_ABI,data:log.data,topics:log.topics});}catch{return undefined;}
  }).filter((event:any)=>event?.eventName==='Approval');
  if(approvalEvents.length!==1)fail('VERIFY_EVENT');
  expectArgs([approvalEvents[0].args.owner,approvalEvents[0].args.spender,approvalEvents[0].args.value],[addresses.payer,core,BigInt(ECONOMICS.approval)]);

  const settlementIds: Hex[]=[];
  for (const kind of ['purchaseA','purchaseB'] as const) {
    const index=STEP_ORDER.indexOf(kind); const decoded=decodeCall(txs[index]!.input);
    if (decoded.functionName!=='settleAssured') fail('VERIFY_SETTLEMENT');
    if (!eq(encodeFunctionData({abi:artifact.abi,functionName:'settleAssured',args:decoded.args as readonly unknown[]}),txs[index]!.input)) fail('VERIFY_SETTLEMENT');
    const intent=intentFromDecoded(decoded); const id=hashIntent(intent);
    const expectedRequestHash=requestHashFor(config,kind);
    if (intent.chainId!=='84532'||!eq(intent.core,core)||!eq(intent.token,tokenAddress)||!eq(intent.payer,addresses.payer)||
        intent.providerId!==config.providerId||intent.policyId!==config.policyId||intent.policyHash!==terms.policyHash||intent.gross!==ECONOMICS.gross||
        intent.requestHash!==expectedRequestHash||intent.payerSalt===ZERO||settlementIds.includes(id)) fail('VERIFY_SETTLEMENT');
    const signature=signatureFromArgs(decoded);
    const block=await client.getBlock({blockNumber:anchors[index]!.blockNumber});
    if (!block||block.timestamp<=BigInt(intent.validAfter)||block.timestamp>=BigInt(intent.validBefore)) fail('VERIFY_SETTLEMENT');
    await receiveSignature(intent,id,signature,addresses.payer);
    const call={intent,intentHash:id,signature,to:core,data:txs[index]!.input};
    const result=await verifySettlement(client,terms,call,rows[index]!.transaction,addresses.relayer,1,parseUnsigned(rows[index]!.nonce));
    if (result.state!=='confirmed'||result.coverageId!==id||result.blockNumber!==String(anchors[index]!.blockNumber)||!eq(result.blockHash,anchors[index]!.blockHash)) fail('VERIFY_SETTLEMENT');
    settlementIds.push(id);
  }
  const revertIntent=intentFromDecoded(finalDecoded); const revertId=hashIntent(revertIntent); const revertSig=signatureFromArgs(finalDecoded);
  if (revertIntent.chainId!=='84532'||!eq(revertIntent.core,core)||!eq(revertIntent.token,tokenAddress)||!eq(revertIntent.payer,addresses.payer)||
      revertIntent.providerId!==config.providerId||revertIntent.policyId!==config.policyId||revertIntent.policyHash!==terms.policyHash||revertIntent.gross!==ECONOMICS.gross||
      revertIntent.requestHash!==rollbackRequestHashFor(config)||revertIntent.payerSalt===ZERO||BigInt(revertIntent.validAfter)===0n||
      BigInt(revertIntent.validBefore)<=BigInt(revertIntent.validAfter)||BigInt(revertIntent.validBefore)-BigInt(revertIntent.validAfter)>300n||
      revertId===settlementIds[0]||revertId===settlementIds[1]) fail('VERIFY_REVERT_INTENT');
  if (!eq(encodeFunctionData({abi:artifact.abi,functionName:'settleAssured',args:finalDecoded.args as readonly unknown[]}),txs[13]!.input)) fail('VERIFY_CALL');
  await receiveSignature(revertIntent,revertId,revertSig,addresses.payer);

  const stateAt=async(block:bigint, coverageId?:Hex):Promise<Snapshot>=>{
    const [coreToken,payer,payout,poolAssets,totalPoolReserved,totalProviderStake,totalLockedStake,coverageCount,activeCoverageCount,providerState,paused]=await Promise.all([
      client.readContract({address:tokenAddress,abi:TOKEN_ABI,functionName:'balanceOf',args:[core],blockNumber:block}),
      client.readContract({address:tokenAddress,abi:TOKEN_ABI,functionName:'balanceOf',args:[addresses.payer],blockNumber:block}),
      client.readContract({address:tokenAddress,abi:TOKEN_ABI,functionName:'balanceOf',args:[addresses.provider],blockNumber:block}),
      read('poolAssets',[],block),read('totalPoolReserved',[],block),read('totalProviderStake',[],block),read('totalLockedStake',[],block),
      read('coverageCount',[],block),read('activeCoverageCount',[],block),read('providers',[config.providerId],block),read('paused',[],block),
    ]);
    const ps=providerState as readonly unknown[];
    const snap:Snapshot={coreToken:asBig(coreToken),payer:asBig(payer),payout:asBig(payout),poolAssets:asBig(poolAssets),
      totalPoolReserved:asBig(totalPoolReserved),totalProviderStake:asBig(totalProviderStake),totalLockedStake:asBig(totalLockedStake),coverageCount:asBig(coverageCount),
      activeCoverageCount:asBig(activeCoverageCount),freeStake:asBig(ps[2]),lockedStake:asBig(ps[3]),paused:paused===true};
    if (paused!==true&&paused!==false) fail('VERIFY_STATE');
    if (coverageId) {
      const c=await read('coverages',[coverageId],block) as readonly unknown[];
      if (!c) fail('VERIFY_STATE');
    }
    if(snap.coreToken<snap.poolAssets+snap.totalProviderStake||snap.poolAssets<snap.totalPoolReserved||snap.totalProviderStake<snap.totalLockedStake||snap.lockedStake!==snap.totalLockedStake) fail('VERIFY_SOLVENCY');
    return snap;
  };
  const s5=await stateAt(anchors[5]!.blockNumber); const s6=await stateAt(anchors[6]!.blockNumber,settlementIds[0]!);
  const s7=await stateAt(anchors[7]!.blockNumber,settlementIds[0]!); const s8=await stateAt(anchors[8]!.blockNumber,settlementIds[0]!);
  const s9=await stateAt(anchors[9]!.blockNumber,settlementIds[1]!); const s10=await stateAt(anchors[10]!.blockNumber,settlementIds[1]!);
  const s11=await stateAt(anchors[11]!.blockNumber,settlementIds[1]!); const s12=await stateAt(anchors[12]!.blockNumber); const s13=await stateAt(anchors[13]!.blockNumber);
  const allowanceAtApprove=asBig(await client.readContract({address:tokenAddress,abi:TOKEN_ABI,functionName:'allowance',args:[addresses.payer,core],blockNumber:anchors[3]!.blockNumber}));
  const allowanceAtPool=asBig(await client.readContract({address:tokenAddress,abi:TOKEN_ABI,functionName:'allowance',args:[addresses.payer,core],blockNumber:anchors[5]!.blockNumber}));
  if (allowanceAtApprove!==U(ECONOMICS.approval)||allowanceAtPool!==0n||s5.coreToken!==U(ECONOMICS.seedStake)+U(ECONOMICS.seedPool)||
      s5.poolAssets!==U(ECONOMICS.seedPool)||s5.totalPoolReserved!==0n||s5.totalProviderStake!==U(ECONOMICS.seedStake)||s5.freeStake!==U(ECONOMICS.seedStake)||s5.lockedStake!==0n) fail('VERIFY_FUNDING');
  const oneCoverageCoreDelta=U(ECONOMICS.premium)+U(ECONOMICS.withheld);
  if(s6.coverageCount!==1n||s6.activeCoverageCount!==1n||s6.coreToken!==s5.coreToken+oneCoverageCoreDelta||s6.poolAssets!==U(ECONOMICS.seedPool)+U(ECONOMICS.premium)||
      s6.totalPoolReserved!==U(ECONOMICS.poolReservation)||s6.totalProviderStake!==U(ECONOMICS.seedStake)+U(ECONOMICS.withheld)||s6.totalLockedStake!==U(ECONOMICS.stakeLock)||
      s6.freeStake!==U(ECONOMICS.seedStake)+U(ECONOMICS.withheld)-U(ECONOMICS.stakeLock)||s6.lockedStake!==U(ECONOMICS.stakeLock)||s6.payer!==s5.payer-U(ECONOMICS.gross)||
      s6.payout!==s5.payout+U(ECONOMICS.net)) fail('VERIFY_PURCHASE_A');
  const claimA=checkCall(7,'fileClaim',[settlementIds[0],decodeFunctionData({abi:STATE_ABI,data:txs[7]!.input}).args[1]],core);
  if (!hex32(claimA.args[1])||claimA.args[1]===ZERO) fail('VERIFY_CLAIM');
  const claimAEvent=e(7,'ClaimFiled') as any;
  if(!claimAEvent)fail('VERIFY_EVENT');
  expectArgs([claimAEvent.args.coverageId,claimAEvent.args.payer,claimAEvent.args.evidenceHash],[settlementIds[0],addresses.payer,claimA.args[1]]);
  const ca=await read('coverages',[settlementIds[0]],anchors[7]!.blockNumber) as readonly unknown[];
  if (ca[13]!==2||ca[14]!==claimA.args[1]||s7.coverageCount!==1n||s7.activeCoverageCount!==1n||s7.totalLockedStake!==s6.totalLockedStake||s7.totalPoolReserved!==s6.totalPoolReserved||
      s7.coreToken!==s6.coreToken||s7.payer!==s6.payer) fail('VERIFY_CLAIM_PIN');
  const ra=decodeFunctionData({abi:STATE_ABI,data:txs[8]!.input});
  if(ra.functionName!=='finalizeClaim') fail('VERIFY_CLAIM');
  expectArgs(ra.args as readonly unknown[],[settlementIds[0],1,BigInt(ECONOMICS.partialRefund),ra.args[3]]);
  if(!hex32(ra.args[3])||ra.args[3]===ZERO)fail('VERIFY_CLAIM');
  const cfa=await read('coverages',[settlementIds[0]],anchors[8]!.blockNumber) as readonly unknown[];
  if(cfa[13]!==3||cfa[16]!==U(ECONOMICS.partialRefund)||cfa[17]!==1||cfa[15]!==ra.args[3])fail('VERIFY_REFUND');
  const resolveAEvent=e(8,'ClaimFinalized') as any;
  if(!resolveAEvent)fail('VERIFY_EVENT');
  expectArgs([resolveAEvent.args.coverageId,resolveAEvent.args.outcome,resolveAEvent.args.refundAmount,resolveAEvent.args.decisionHash],[settlementIds[0],1,BigInt(ECONOMICS.partialRefund),ra.args[3]]);
  const afterA={...s6};
  if(s8.coreToken!==afterA.coreToken-U(ECONOMICS.partialRefund)||s8.payer!==afterA.payer+U(ECONOMICS.partialRefund)||s8.totalLockedStake!==afterA.totalLockedStake-U(ECONOMICS.stakeLock)||
      s8.totalProviderStake!==afterA.totalProviderStake-U(ECONOMICS.partialRefund)||s8.freeStake!==afterA.freeStake+U(ECONOMICS.stakeLock)-U(ECONOMICS.partialRefund)||
      s8.totalPoolReserved!==afterA.totalPoolReserved-U(ECONOMICS.poolReservation)||s8.poolAssets!==afterA.poolAssets||s8.activeCoverageCount!==0n)fail('VERIFY_REFUND_WATERFALL');
  if(s9.coverageCount!==2n||s9.activeCoverageCount!==1n||s9.coreToken!==s8.coreToken+oneCoverageCoreDelta||s9.poolAssets!==s8.poolAssets+U(ECONOMICS.premium)||
      s9.totalPoolReserved!==U(ECONOMICS.poolReservation)||s9.totalProviderStake!==s8.totalProviderStake+U(ECONOMICS.withheld)||s9.totalLockedStake!==U(ECONOMICS.stakeLock)||
      s9.payer!==s8.payer-U(ECONOMICS.gross)||s9.payout!==s8.payout+U(ECONOMICS.net))fail('VERIFY_PURCHASE_B');
  const claimB=checkCall(10,'fileClaim',[settlementIds[1],decodeFunctionData({abi:STATE_ABI,data:txs[10]!.input}).args[1]],core);
  if(!hex32(claimB.args[1])||claimB.args[1]===ZERO)fail('VERIFY_CLAIM');
  const cb=await read('coverages',[settlementIds[1]],anchors[10]!.blockNumber) as readonly unknown[];
  const claimBEvent=e(10,'ClaimFiled') as any;
  if(!claimBEvent)fail('VERIFY_EVENT');
  expectArgs([claimBEvent.args.coverageId,claimBEvent.args.payer,claimBEvent.args.evidenceHash],[settlementIds[1],addresses.payer,claimB.args[1]]);
  if(cb[13]!==2||cb[14]!==claimB.args[1]||s10.totalLockedStake!==s9.totalLockedStake||s10.totalPoolReserved!==s9.totalPoolReserved||s10.coreToken!==s9.coreToken||s10.payer!==s9.payer)fail('VERIFY_CLAIM_PIN');
  const rb=decodeFunctionData({abi:STATE_ABI,data:txs[11]!.input});
  if(rb.functionName!=='finalizeClaim')fail('VERIFY_CLAIM');
  expectArgs(rb.args as readonly unknown[],[settlementIds[1],2,BigInt(ECONOMICS.fullRefund),rb.args[3]]);
  if(!hex32(rb.args[3])||rb.args[3]===ZERO)fail('VERIFY_CLAIM');
  const cfb=await read('coverages',[settlementIds[1]],anchors[11]!.blockNumber) as readonly unknown[];
  if(cfb[13]!==3||cfb[16]!==U(ECONOMICS.fullRefund)||cfb[17]!==2||cfb[15]!==rb.args[3])fail('VERIFY_REFUND');
  const resolveBEvent=e(11,'ClaimFinalized') as any;
  if(!resolveBEvent)fail('VERIFY_EVENT');
  expectArgs([resolveBEvent.args.coverageId,resolveBEvent.args.outcome,resolveBEvent.args.refundAmount,resolveBEvent.args.decisionHash],[settlementIds[1],2,BigInt(ECONOMICS.fullRefund),rb.args[3]]);
  if(s11.coreToken!==s9.coreToken-U(ECONOMICS.fullRefund)||s11.payer!==s9.payer+U(ECONOMICS.fullRefund)||s11.poolAssets!==s9.poolAssets-U(ECONOMICS.fullRefund)||
      s11.totalPoolReserved!==s9.totalPoolReserved-U(ECONOMICS.poolReservation)||s11.totalLockedStake!==s9.totalLockedStake-U(ECONOMICS.stakeLock)||
      s11.totalProviderStake!==s9.totalProviderStake||s11.freeStake!==s9.freeStake+U(ECONOMICS.stakeLock)||s11.activeCoverageCount!==0n||s11.coverageCount!==2n||s11.totalLockedStake!==0n)fail('VERIFY_POOL_ONLY');
  if(!s12.paused||s13.paused!==s12.paused)fail('VERIFY_PAUSE');
  if(s12.payer<U(ECONOMICS.gross)||s12.freeStake<U(ECONOMICS.stakeLock)||
      s12.poolAssets-s12.totalPoolReserved<U(ECONOMICS.poolReservation))fail('VERIFY_REVERT_ADMISSION_CAPACITY');
  const sameFinancialState=(a:Snapshot,b:Snapshot)=>a.coreToken===b.coreToken&&a.payer===b.payer&&a.payout===b.payout&&a.poolAssets===b.poolAssets&&
    a.totalPoolReserved===b.totalPoolReserved&&a.totalProviderStake===b.totalProviderStake&&a.totalLockedStake===b.totalLockedStake&&
    a.coverageCount===b.coverageCount&&a.activeCoverageCount===b.activeCoverageCount&&a.freeStake===b.freeStake&&a.lockedStake===b.lockedStake;
  if(!sameFinancialState(s11,s12)||!sameFinancialState(s12,s13))fail('VERIFY_POST_SETTLEMENT_STATE');
  const revertReceipt=receipts[13]!;
  const revertBlock=await client.getBlock({blockNumber:anchors[13]!.blockNumber});
  if(!revertBlock||revertBlock.timestamp<=BigInt(revertIntent.validAfter)||revertBlock.timestamp>=BigInt(revertIntent.validBefore))fail('VERIFY_REVERT_SIGNATURE');
  if(revertReceipt.logs.length!==0||await client.readContract({address:tokenAddress,abi:TOKEN_ABI,functionName:'authorizationState',args:[addresses.payer,revertId],blockNumber:anchors[13]!.blockNumber})!==false)fail('VERIFY_REVERT_ROLLBACK');
  const missing=await read('coverages',[revertId],anchors[13]!.blockNumber) as readonly unknown[];
  if(!eq(missing[0],ZERO_ADDRESS)||missing[13]!==0||s13.coreToken!==s12.coreToken||s13.payer!==s12.payer||s13.payout!==s12.payout||
      s13.poolAssets!==s12.poolAssets||s13.totalPoolReserved!==s12.totalPoolReserved||s13.totalProviderStake!==s12.totalProviderStake||s13.totalLockedStake!==s12.totalLockedStake||
      s13.coverageCount!==s12.coverageCount||s13.activeCoverageCount!==s12.activeCoverageCount)fail('VERIFY_REVERT_ROLLBACK');
  const finalBlock=await client.getBlockNumber();
  for(const anchor of anchors){
    const fresh=await client.getBlock({blockNumber:anchor.blockNumber});
    if(finalBlock<anchor.blockNumber||!fresh?.hash||!eq(fresh.hash,anchor.blockHash))fail('VERIFY_CANONICAL_FINAL');
  }
  return {ok:true,code:local?'M5_LOCAL_REHEARSAL_VERIFIED':'M5_PUBLIC_CHAIN_VERIFIED',transactions:verified,
    limits:{finality:false,httpProvenFromChain:false,postReceiveRollbackProven:false}};
}

/** Independent read-only chain verifier. Signature fragments exist only in local call frames. */
export async function verifyCampaign(options: VerifyOptions): Promise<VerificationReport> {
  try {
    // The campaign is untrusted input. Detach it synchronously before any RPC
    // await so a caller cannot swap identities/config midway through proof.
    const snapshot: VerifyOptions = {
      client: options.client,
      manifest: structuredClone(options.manifest),
      artifact: structuredClone(options.artifact),
      allowLocalFixture: options.allowLocalFixture === true,
    };
    return await verify(snapshot);
  }
  catch (error) {
    const known = error instanceof Error && /^VERIFY_[A-Z0-9_]+$/.test(error.message) ? error.message : 'VERIFY_FAILED';
    return {ok:false,code:known,transactions:[],limits:{finality:false,httpProvenFromChain:false,postReceiveRollbackProven:false}};
  }
}
