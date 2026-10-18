import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { afterEach, beforeEach } from 'node:test';
import {
  decodeEventLog, encodeFunctionData, parseSignature, toFunctionSelector,
  type Address, type Hex,
} from 'viem';
import {
  attemptRevert, compileContracts, deploy, signCancel, signReceive, signTransfer,
  solidityIntent, startEvm, transact, type Evm,
} from './helpers/evm.js';
import { hashIntent, type Intent } from '../src/intent.js';

const vector = JSON.parse(readFileSync(new URL('../vectors/intent-v1.json', import.meta.url), 'utf8')) as {
  intent: Intent; intentHash: Hex;
};
const providerId = `0x${'44'.repeat(32)}` as Hex;
const policyId = `0x${'55'.repeat(32)}` as Hex;
const policyHash = `0x${'66'.repeat(32)}` as Hex;
const requestHash = `0x${'77'.repeat(32)}` as Hex;
const ZERO = `0x${'00'.repeat(32)}` as Hex;

let evm: Evm;
let token: Address;
let core: Address;
let tokenArtifact: ReturnType<typeof compileContracts>[string];
let coreArtifact: ReturnType<typeof compileContracts>[string];

async function read(abi: any, address: Address, functionName: string, args: readonly unknown[] = []) {
  return evm.publicClient.readContract({ abi, address, functionName, args });
}

async function freshIntent(duration = 200n): Promise<Intent> {
  const block = await evm.publicClient.getBlock({ blockTag: 'latest' });
  const validAfter = block.timestamp > 100n ? block.timestamp - 100n : 1n;
  return {
    chainId: '84532', core, token, payer: evm.payer.address,
    providerId, policyId, policyHash, requestHash,
    gross: '100', payerSalt: `0x${'a1'.repeat(32)}`,
    validAfter: String(validAfter), validBefore: String(validAfter + duration),
  };
}

async function deployPair() {
  token = await deploy(evm, tokenArtifact);
  core = await deploy(evm, coreArtifact, [token, evm.provider.address, providerId, policyId, policyHash]);
}

// Keep the signature shape local; only v/r/s are sent to contracts.
function sigArgs(signature: { v: number; r: Hex; s: Hex }) {
  return [signature.v, signature.r, signature.s] as const;
}

async function settle(intent: Intent, signature?: { v: number; r: Hex; s: Hex }) {
  return transact(evm, coreArtifact.abi, core, 'settleAssured', [
    solidityIntent(intent), ...sigArgs(signature ?? await signReceive(evm.payer, intent)),
  ]);
}

async function settleReverted(intent: Intent, signature?: { v: number; r: Hex; s: Hex }) {
  return attemptRevert(evm, coreArtifact.abi, core, 'settleAssured', [
    solidityIntent(intent), ...sigArgs(signature ?? await signReceive(evm.payer, intent)),
  ]);
}

async function balances() {
  return Promise.all([
    read(tokenArtifact.abi, token, 'balanceOf', [evm.payer.address]),
    read(tokenArtifact.abi, token, 'balanceOf', [core]),
    read(tokenArtifact.abi, token, 'balanceOf', [evm.provider.address]),
  ]);
}

async function mintPayer() {
  await transact(evm, tokenArtifact.abi, token, 'mint', [evm.payer.address, 100n]);
}

async function assertNoSettlement(intent: Intent) {
  assert.deepEqual(await balances(), [100n, 0n, 0n]);
  assert.equal(await read(tokenArtifact.abi, token, 'authorizationState', [intent.payer, hashIntent(intent)]), false);
  assert.deepEqual(await read(coreArtifact.abi, core, 'coverages', [hashIntent(intent)]), [
    '0x0000000000000000000000000000000000000000', ZERO, 0n,
  ]);
  assert.equal(await read(coreArtifact.abi, core, 'coverageCount'), 0n);
  assert.equal(await read(coreArtifact.abi, core, 'premiumReserve'), 0n);
}

beforeEach(async () => {
  evm = await startEvm();
  const artifacts = compileContracts();
  tokenArtifact = artifacts.AuthorizationTokenMock!;
  coreArtifact = artifacts.AssuranceCoreSpike!;
  await deployPair();
});
afterEach(async () => { await evm.close(); });

test('Solidity intent hash matches the published unsigned vector', async () => {
  assert.equal(hashIntent(vector.intent), vector.intentHash);
  assert.equal(await read(coreArtifact.abi, core, 'hashIntent', [solidityIntent(vector.intent)]), vector.intentHash);
});

test('receive settles exact 100/93/7, records the coverage, event, and nonce once', async () => {
  const intent = await freshIntent();
  await mintPayer();
  const signature = await signReceive(evm.payer, intent);
  const receipt = await settle(intent, signature);

  assert.deepEqual(await balances(), [0n, 7n, 93n]);
  const id = hashIntent(intent);
  assert.equal(await read(tokenArtifact.abi, token, 'authorizationState', [intent.payer, id]), true);
  assert.deepEqual(await read(coreArtifact.abi, core, 'coverages', [id]), [intent.payer, intent.requestHash, 100n]);
  assert.equal(await read(coreArtifact.abi, core, 'coverageCount'), 1n);
  assert.equal(await read(coreArtifact.abi, core, 'premiumReserve'), 7n);
  const opened = receipt.logs.map((log: any) => {
    try { return decodeEventLog({ abi: coreArtifact.abi, data: log.data, topics: log.topics }); }
    catch { return undefined; }
  }).find((log: any) => log?.eventName === 'CoverageOpened') as any;
  assert.ok(opened);
  assert.deepEqual(opened.args, {
    coverageId: id, payer: intent.payer, providerId, policyId,
    requestHash: intent.requestHash, gross: 100n, net: 93n, premium: 7n,
  });

  await attemptRevert(evm, coreArtifact.abi, core, 'settleAssured', [
    solidityIntent(intent), ...sigArgs(signature),
  ]);
  assert.deepEqual(await balances(), [0n, 7n, 93n]);
  assert.equal(await read(coreArtifact.abi, core, 'coverageCount'), 1n);
});

test('all twelve intent fields are signature-bound and immutable bindings reject substitutions', async () => {
  const intent = await freshIntent();
  await mintPayer();
  const signature = await signReceive(evm.payer, intent);
  const mutations: Array<[keyof Intent, string]> = [
    ['chainId', '84533'],
    ['core', evm.outsider.address],
    ['token', evm.outsider.address],
    ['payer', evm.outsider.address],
    ['providerId', `0x${'91'.repeat(32)}`],
    ['policyId', `0x${'92'.repeat(32)}`],
    ['policyHash', `0x${'93'.repeat(32)}`],
    ['requestHash', `0x${'94'.repeat(32)}`],
    ['gross', '101'],
    ['payerSalt', `0x${'95'.repeat(32)}`],
    ['validAfter', String(BigInt(intent.validAfter) + 1n)],
    ['validBefore', String(BigInt(intent.validBefore) + 1n)],
  ];
  for (const [field, value] of mutations) {
    const changed = { ...intent, [field]: value } as Intent;
    await settleReverted(changed, signature);
    assert.equal(await read(tokenArtifact.abi, token, 'authorizationState', [changed.payer, hashIntent(changed)]), false);
    assert.equal(await read(tokenArtifact.abi, token, 'authorizationState', [intent.payer, hashIntent(intent)]), false);
    assert.deepEqual(await read(coreArtifact.abi, core, 'coverages', [hashIntent(changed)]), [
      '0x0000000000000000000000000000000000000000', ZERO, 0n,
    ]);
    assert.equal(await read(coreArtifact.abi, core, 'coverageCount'), 0n);
  }
  assert.deepEqual(await balances(), [100n, 0n, 0n]);
});

test('wrong signer, domain, transfer type, and transfer nonce cannot settle receive authorization', async () => {
  const intent = await freshIntent();
  await mintPayer();
  const wrongSigner = await signReceive(evm.outsider, intent);
  await settleReverted(intent, wrongSigner);
  await settleReverted(intent, await signTransfer(evm.payer, intent));

  const typed = await signReceive(evm.payer, intent);
  const { buildReceiveWithAuthorization } = await import('../src/intent.js');
  const typedData = buildReceiveWithAuthorization(intent, hashIntent(intent), {
    name: 'USDC', version: '2', chainId: 84532n, token,
  });
  const wrongDomainSignature = await evm.payer.signTypedData({
    ...typedData, domain: { ...typedData.domain, version: '1' },
  });
  const parsedWrongDomain = parseSignature(wrongDomainSignature);
  await settleReverted(intent, {
    v: Number(parsedWrongDomain.v ?? BigInt((parsedWrongDomain.yParity ?? 0) + 27)),
    r: parsedWrongDomain.r!, s: parsedWrongDomain.s!,
  });
  assert.notEqual(typed.signature, wrongDomainSignature);
  await assertNoSettlement(intent);
});

test('authorization window edges and direct extraction are enforced in EVM execution', async () => {
  const maxWindow = await freshIntent(300n);
  await mintPayer();
  await settle(maxWindow);
  assert.deepEqual(await balances(), [0n, 7n, 93n]);

  await mintPayer();
  const tooLong = { ...await freshIntent(301n), payerSalt: `0x${'a2'.repeat(32)}` as Hex };
  await settleReverted(tooLong);

  const latest = await evm.publicClient.getBlock({ blockTag: 'latest' });
  const notYet = { ...await freshIntent(), payerSalt: `0x${'a3'.repeat(32)}` as Hex,
    validAfter: String(latest.timestamp + 20n), validBefore: String(latest.timestamp + 200n) };
  const expired = { ...await freshIntent(), payerSalt: `0x${'a4'.repeat(32)}` as Hex,
    validAfter: String(latest.timestamp - 200n), validBefore: String(latest.timestamp - 10n) };
  await settleReverted(notYet);
  await settleReverted(expired);
  assert.equal(await read(coreArtifact.abi, core, 'coverageCount'), 1n);
  assert.equal(await read(tokenArtifact.abi, token, 'authorizationState', [notYet.payer, hashIntent(notYet)]), false);
  assert.equal(await read(tokenArtifact.abi, token, 'authorizationState', [expired.payer, hashIntent(expired)]), false);
  assert.deepEqual(await balances(), [100n, 7n, 93n]);

  // Mine at the exact lower and upper boundaries to prove both inequalities are strict.
  const lowerBoundary = { ...await freshIntent(), payerSalt: `0x${'a6'.repeat(32)}` as Hex,
    validAfter: String(latest.timestamp + 30n), validBefore: String(latest.timestamp + 230n) };
  const lowerSig = await signReceive(evm.payer, lowerBoundary);
  await (evm.publicClient.request as any)({ method: 'evm_setNextBlockTimestamp', params: [Number(lowerBoundary.validAfter)] });
  const lowerReceipt = await settleReverted(lowerBoundary, lowerSig);
  assert.equal((await evm.publicClient.getBlock({ blockNumber: lowerReceipt.blockNumber })).timestamp,
    BigInt(lowerBoundary.validAfter));

  const upperBoundary = { ...await freshIntent(), payerSalt: `0x${'a7'.repeat(32)}` as Hex,
    validAfter: String(latest.timestamp + 30n), validBefore: String(latest.timestamp + 230n) };
  const upperSig = await signReceive(evm.payer, upperBoundary);
  await (evm.publicClient.request as any)({ method: 'evm_setNextBlockTimestamp', params: [Number(upperBoundary.validBefore)] });
  const upperReceipt = await settleReverted(upperBoundary, upperSig);
  assert.equal((await evm.publicClient.getBlock({ blockNumber: upperReceipt.blockNumber })).timestamp,
    BigInt(upperBoundary.validBefore));

  const direct = { ...await freshIntent(), payerSalt: `0x${'a5'.repeat(32)}` as Hex };
  const signature = await signReceive(evm.payer, direct);
  await attemptRevert(evm, tokenArtifact.abi, token, 'receiveWithAuthorization', [
    direct.payer, core, BigInt(direct.gross), BigInt(direct.validAfter), BigInt(direct.validBefore),
    hashIntent(direct), ...sigArgs(signature),
  ], evm.payer);
  assert.equal(await read(tokenArtifact.abi, token, 'authorizationState', [direct.payer, hashIntent(direct)]), false);
});

test('signed cancellation consumes a nonce and blocks the matching Core settlement', async () => {
  const intent = await freshIntent();
  await mintPayer();
  const nonce = hashIntent(intent);
  const cancel = await signCancel(evm.payer, token, nonce);
  await transact(evm, tokenArtifact.abi, token, 'cancelAuthorization', [intent.payer, nonce, ...sigArgs(cancel)], evm.outsider);
  assert.equal(await read(tokenArtifact.abi, token, 'authorizationState', [intent.payer, nonce]), true);
  await settleReverted(intent);
  assert.deepEqual(await balances(), [100n, 0n, 0n]);
  assert.equal(await read(tokenArtifact.abi, token, 'authorizationState', [intent.payer, nonce]), true);
  assert.deepEqual(await read(coreArtifact.abi, core, 'coverages', [nonce]), [
    '0x0000000000000000000000000000000000000000', ZERO, 0n,
  ]);
  assert.equal(await read(coreArtifact.abi, core, 'coverageCount'), 0n);
  assert.equal(await read(coreArtifact.abi, core, 'premiumReserve'), 0n);
});

test('admission, false-return transfer, fee mismatch, and postcondition failure roll back nested token state', async () => {
  const cases: Array<{ name: string; setup: (intent: Intent) => Promise<void> }> = [
    { name: 'admission disabled', setup: async () => transact(evm, coreArtifact.abi, core, 'setAdmissionEnabled', [false]) },
    { name: 'provider transfer returns false', setup: async () => transact(evm, tokenArtifact.abi, token, 'setFailTransfers', [true]) },
    { name: 'provider transfer burns a fee', setup: async () => transact(evm, tokenArtifact.abi, token, 'setTransferFee', [1n]) },
    { name: 'forced postcondition failure after transfer', setup: async () => transact(evm, coreArtifact.abi, core, 'setFailAfterTransfer', [true]) },
  ];
  for (const item of cases) {
    await deployPair();
    const intent = await freshIntent();
    await mintPayer();
    await item.setup(intent);
    const nativeBefore = await evm.publicClient.getBalance({ address: evm.owner.address });
    const receipt = await settleReverted(intent);
    const nativeAfter = await evm.publicClient.getBalance({ address: evm.owner.address });
    assert.deepEqual(await balances(), [100n, 0n, 0n], item.name);
    assert.equal(await read(tokenArtifact.abi, token, 'authorizationState', [intent.payer, hashIntent(intent)]), false, item.name);
    assert.deepEqual(await read(coreArtifact.abi, core, 'coverages', [hashIntent(intent)]), [
      '0x0000000000000000000000000000000000000000', ZERO, 0n,
    ], item.name);
    assert.equal(await read(coreArtifact.abi, core, 'coverageCount'), 0n, item.name);
    assert.equal(await read(coreArtifact.abi, core, 'premiumReserve'), 0n, item.name);
    assert.ok(nativeAfter < nativeBefore, `${item.name}: reverted transaction still paid relayer gas`);
    assert.equal(nativeBefore - nativeAfter, receipt.gasUsed * receipt.effectiveGasPrice, item.name);
  }
});

test('fixture controls reject non-admin callers', async () => {
  await attemptRevert(evm, tokenArtifact.abi, token, 'setFailTransfers', [true], evm.outsider);
  await attemptRevert(evm, tokenArtifact.abi, token, 'setTransferFee', [1n], evm.outsider);
  await attemptRevert(evm, tokenArtifact.abi, token, 'setReentry', [core, '0x'], evm.outsider);
  await attemptRevert(evm, coreArtifact.abi, core, 'setAdmissionEnabled', [false], evm.outsider);
  await attemptRevert(evm, coreArtifact.abi, core, 'setFailAfterTransfer', [true], evm.outsider);
  assert.equal(await read(tokenArtifact.abi, token, 'failTransfers'), false);
  assert.equal(await read(tokenArtifact.abi, token, 'transferFee'), 0n);
  assert.equal(await read(coreArtifact.abi, core, 'admissionEnabled'), true);
  assert.equal(await read(coreArtifact.abi, core, 'failAfterTransfer'), false);
});

test('token callback attempts reentry during provider transfer and Core guard blocks it', async () => {
  const intent = await freshIntent();
  await mintPayer();
  const signature = await signReceive(evm.payer, intent);
  const callback = encodeFunctionData({ abi: coreArtifact.abi, functionName: 'settleAssured', args: [
    solidityIntent(intent), ...sigArgs(signature),
  ] });
  await transact(evm, tokenArtifact.abi, token, 'setReentry', [core, callback]);
  await settle(intent, signature);
  assert.equal(await read(tokenArtifact.abi, token, 'lastReentrySucceeded'), false);
  assert.equal(await read(tokenArtifact.abi, token, 'lastReentrySelector'),
    toFunctionSelector('ReentrancyGuardReentrantCall()'));
  assert.deepEqual(await balances(), [0n, 7n, 93n]);
  assert.equal(await read(coreArtifact.abi, core, 'coverageCount'), 1n);
});
