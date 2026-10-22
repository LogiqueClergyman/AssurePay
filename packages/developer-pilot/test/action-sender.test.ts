import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { encodeFunctionData, keccak256, toBytes, type Address, type Hex } from 'viem';
import { CORE_ABI } from '../../claims-backend/src/abi.js';
import type { BackendContext, PreparedAction } from '../../claims-backend/src/types.js';
import { hashPolicy, typeIntent } from '../../evm-core/test/helpers/intent.js';
import { hashIntent, signReceive, transact } from '../../evm-core/test/helpers/evm.js';
import { acquireActorLock, createActionSender } from '../src/action-sender.js';
import { createPilotFixture } from './helpers.js';

async function openCoverage(f: Awaited<ReturnType<typeof createPilotFixture>>) {
  const { evm, config } = f;
  const block = await evm.publicClient.getBlock({ blockTag: 'latest' });
  const policyHash = hashPolicy({ providerId: config.providerId, policyId: config.policyId,
    providerOwner: evm.provider.address, providerPayout: evm.provider.address,
    premiumBps: 777, stakeBps: 3500, withholdingBps: 2200, duration: 3600n, poolOnlyAllowed: true });
  const intent = { chainId: '84532', core: config.core, token: config.token, payer: evm.payer.address,
    providerId: config.providerId, policyId: config.policyId, policyHash, requestHash: keccak256(toBytes('pilot request')),
    gross: config.gross, payerSalt: keccak256(toBytes(`salt:${Math.random()}`)),
    validAfter: (block.timestamp - 1n).toString(), validBefore: (block.timestamp + 250n).toString() };
  const signature = await signReceive(evm.payer, intent);
  await transact(evm, f.artifacts.AssuranceCore.abi, config.core, 'settleAssured',
    [typeIntent(intent), signature.v, signature.r, signature.s]);
  const coverageId = hashIntent(intent);
  const observed = await evm.publicClient.getBlock({ blockTag: 'latest' });
  return { coverageId, observed };
}

function action(context: BackendContext, coverageId: Hex, from: Address, observed: { number: bigint; hash: Hex }, data: Hex): PreparedAction {
  return { chainId: 84532, to: context.core, from, data, value: '0', coverageId,
    observedBlock: { number: observed.number.toString(), hash: observed.hash } };
}

test('restricted action sender files and resolves a claim on the actual EVM, then reconciles without a signer', async () => {
  const f = await createPilotFixture();
  let payerSender: Awaited<ReturnType<typeof createActionSender>> | undefined;
  let adjudicatorSender: Awaited<ReturnType<typeof createActionSender>> | undefined;
  try {
    const context: BackendContext = { chainId: 84532, core: f.config.core, token: f.config.token,
      adjudicator: f.config.roles.adjudicator, serviceId: f.config.serviceId };
    const { coverageId, observed } = await openCoverage(f);
    const evidenceHash = keccak256(toBytes('opaque synthetic evidence'));
    const claim = action(context, coverageId, f.accounts.payer.address, observed,
      encodeFunctionData({ abi: CORE_ABI, functionName: 'fileClaim', args: [coverageId, evidenceHash] }));
    let signatures = 0;
    const payerWallet = { chain: f.evm.walletClient.chain, async signTransaction(args: any) { signatures++; const { chain, account, ...tx } = args; return account.signTransaction({ ...tx, chainId: chain.id }); } };
    const payerPath = `${f.directory}/payer-actions.json`;
    payerSender = await createActionSender({ context, actor: f.accounts.payer.address, client: f.evm.publicClient, wallet: payerWallet as any,
      account: f.evm.payer, journalPath: payerPath, polls: 2, delay: 0 });

    await assert.rejects(() => payerSender!.submit({ ...claim, from: f.accounts.provider.address }), /ACTION_ACTOR_MISMATCH/);
    const wrongSelector = { ...claim, data: encodeFunctionData({ abi: CORE_ABI, functionName: 'token' }) };
    await assert.rejects(() => payerSender!.submit(wrongSelector), /ACTION_SELECTOR_INVALID/);
    await assert.rejects(() => createActionSender({ context, actor: f.accounts.payer.address, client: f.evm.publicClient,
      journalPath: `${f.directory}/other-payer.json` }), /ACTION_LOCK_UNAVAILABLE/);
    assert.equal(signatures, 0);

    const filed = await payerSender.submit(claim);
    assert.equal(filed.status, 'success'); assert.equal(filed.attempted, true);
    assert.equal(filed.gas, '100000'); assert.equal(filed.maxFeePerGas, '100000000'); assert.equal(filed.maxPriorityFeePerGas, '1000000');
    assert.equal(signatures, 1);
    const coverageAfterFile = await f.evm.publicClient.readContract({ address: context.core, abi: CORE_ABI,
      functionName: 'coverages', args: [coverageId] });
    assert.equal(coverageAfterFile[13], 2); assert.equal(coverageAfterFile[14].toLowerCase(), evidenceHash.toLowerCase());
    const saved = JSON.parse(await readFile(payerPath, 'utf8'));
    assert.deepEqual(Object.keys(saved.records[0]).sort(), ['kind','coverageId','transaction','from','to','nonce','calldataHash','gas',
      'maxFeePerGas','maxPriorityFeePerGas','value','attempted','blockNumber','blockHash','status'].sort());
    assert.equal(JSON.stringify(saved).includes(evidenceHash), false);
    await payerSender.close(); payerSender = undefined;

    const recoveredPayer = await createActionSender({ context, actor: f.accounts.payer.address, client: f.evm.publicClient, journalPath: payerPath, polls: 1, delay: 0 });
    const recovered = await recoveredPayer.reconcile();
    assert.equal(recovered.length, 1); assert.equal(recovered[0]!.transaction, filed.transaction); assert.equal(recovered[0]!.status, 'success');
    await recoveredPayer.close();

    const decisionHash = keccak256(toBytes('explicit pilot decision'));
    const decisionObserved = await f.evm.publicClient.getBlock({ blockTag: 'latest' });
    const decision = action(context, coverageId, f.accounts.adjudicator.address, decisionObserved,
      encodeFunctionData({ abi: CORE_ABI, functionName: 'finalizeClaim', args: [coverageId, 2, BigInt(f.config.gross), decisionHash] }));
    const beforeRefund = await f.evm.publicClient.readContract({ address: context.token, abi: f.artifacts.AuthorizationTokenMock.abi,
      functionName: 'balanceOf', args: [f.accounts.payer.address] });
    adjudicatorSender = await createActionSender({ context, actor: f.accounts.adjudicator.address, client: f.evm.publicClient,
      wallet: f.evm.walletClient, account: f.accounts.adjudicator, journalPath: `${f.directory}/adjudicator-actions.json`, polls: 2, delay: 0 });
    const resolved = await adjudicatorSender.submit(decision);
    assert.equal(resolved.status, 'success'); assert.equal(resolved.gas, '220000');
    const coverageFinal = await f.evm.publicClient.readContract({ address: context.core, abi: CORE_ABI, functionName: 'coverages', args: [coverageId] });
    assert.equal(coverageFinal[13], 3); assert.equal(coverageFinal[16], BigInt(f.config.gross)); assert.equal(coverageFinal[17], 2);
    const afterRefund = await f.evm.publicClient.readContract({ address: context.token, abi: f.artifacts.AuthorizationTokenMock.abi,
      functionName: 'balanceOf', args: [f.accounts.payer.address] });
    assert.equal(afterRefund - beforeRefund, BigInt(f.config.gross));
    const coreBalance = await f.evm.publicClient.readContract({ address: context.token, abi: f.artifacts.AuthorizationTokenMock.abi,
      functionName: 'balanceOf', args: [context.core] });
    const poolAssets = await f.evm.publicClient.readContract({ address: context.core, abi: f.artifacts.AssuranceCore.abi, functionName: 'poolAssets' });
    const providerStake = await f.evm.publicClient.readContract({ address: context.core, abi: f.artifacts.AssuranceCore.abi, functionName: 'totalProviderStake' });
    const locked = await f.evm.publicClient.readContract({ address: context.core, abi: f.artifacts.AssuranceCore.abi, functionName: 'totalLockedStake' });
    const reserved = await f.evm.publicClient.readContract({ address: context.core, abi: f.artifacts.AssuranceCore.abi, functionName: 'totalPoolReserved' });
    assert.equal(coreBalance, poolAssets + providerStake); assert.equal(locked, 0n); assert.equal(reserved, 0n);
  } finally {
    await payerSender?.close().catch(() => undefined); await adjudicatorSender?.close().catch(() => undefined); await f.close();
  }
});

test('action sender strands an unknown send, reconciles only its original hash, and rejects a tampered journal', async () => {
  const f = await createPilotFixture();
  let sender: Awaited<ReturnType<typeof createActionSender>> | undefined;
  try {
    const context: BackendContext = { chainId: 84532, core: f.config.core, token: f.config.token,
      adjudicator: f.config.roles.adjudicator, serviceId: f.config.serviceId };
    const { coverageId, observed } = await openCoverage(f);
    const claim = action(context, coverageId, f.accounts.payer.address, observed,
      encodeFunctionData({ abi: CORE_ABI, functionName: 'fileClaim', args: [coverageId, keccak256(toBytes('evidence'))] }));
    let sent = 0; let signed = 0; let hideReceipt = true;
    const uncertainClient = new Proxy(f.evm.publicClient, { get(target, property) {
      if (property === 'sendRawTransaction') return async (args: any) => { sent++; await f.evm.publicClient.sendRawTransaction(args); throw new Error('simulated lost response'); };
      if (property === 'getTransaction' || property === 'getTransactionReceipt') return async (args: any) => hideReceipt ? null : f.evm.publicClient[property](args);
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const wallet = { chain: f.evm.walletClient.chain, async signTransaction(args: any) { signed++; const { chain, account, ...tx } = args; return account.signTransaction({ ...tx, chainId: chain.id }); } };
    const path = `${f.directory}/unknown.json`;
    sender = await createActionSender({ context, actor: f.accounts.payer.address, client: uncertainClient, wallet: wallet as any,
      account: f.evm.payer, journalPath: path, polls: 1, delay: 0 });
    const unknown = await sender.submit(claim);
    assert.equal(unknown.attempted, true); assert.equal(unknown.status, undefined); assert.equal(sent, 1); assert.equal(signed, 1);
    const repeated = await sender.submit(claim);
    assert.equal(repeated.transaction, unknown.transaction); assert.equal(repeated.status, undefined); assert.equal(sent, 1);
    const second = await openCoverage(f);
    const laterAction = action(context, second.coverageId, f.accounts.payer.address, second.observed,
      encodeFunctionData({ abi: CORE_ABI, functionName: 'fileClaim', args: [second.coverageId, keccak256(toBytes('later evidence'))] }));
    await assert.rejects(() => sender!.submit(laterAction), /ACTION_UNRESOLVED/);
    await sender.close(); sender = undefined;

    const recovered = await createActionSender({ context, actor: f.accounts.payer.address, client: f.evm.publicClient, journalPath: path, polls: 1, delay: 0 });
    hideReceipt = false;
    const rows = await recovered.reconcile();
    assert.equal(rows[0]!.transaction, unknown.transaction); assert.equal(rows[0]!.status, 'success'); assert.equal(sent, 1); assert.equal(signed, 1);
    const unavailableClient = new Proxy(f.evm.publicClient, { get(target, property) {
      if (property === 'getBlock') return async () => { throw new Error('RPC unavailable'); };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await recovered.close();
    const unavailable = await createActionSender({ context, actor: f.accounts.payer.address, client: unavailableClient, journalPath: path, polls: 1, delay: 0 });
    await assert.rejects(() => unavailable.reconcile(), /ACTION_CANONICALITY_UNAVAILABLE/);
    await unavailable.close();

    const data = JSON.parse(await readFile(path, 'utf8')); data.unexpected = true; await writeFile(path, JSON.stringify(data));
    await assert.rejects(() => createActionSender({ context, actor: f.accounts.payer.address, client: f.evm.publicClient, journalPath: path }), /ACTION_JOURNAL_INVALID/);
    const reopened = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(reopened.records[0].transaction, unknown.transaction);
    assert.equal(sent, 1);
  } finally { await sender?.close().catch(() => undefined); await f.close(); }
});

test('actor lock is exclusive and explicit release permits a later owner', async () => {
  const actor = '0x0000000000000000000000000000000000000088' as Address;
  const release = await acquireActorLock(actor);
  try { await assert.rejects(() => acquireActorLock(actor), /ACTION_LOCK_UNAVAILABLE/); }
  finally { await release(); }
  const next = await acquireActorLock(actor); await next();
});

test('an expired prepared claim is rejected before signing', async () => {
  const f = await createPilotFixture();
  let sender: Awaited<ReturnType<typeof createActionSender>> | undefined;
  try {
    const context: BackendContext = { chainId: 84532, core: f.config.core, token: f.config.token,
      adjudicator: f.config.roles.adjudicator, serviceId: f.config.serviceId };
    const { coverageId, observed } = await openCoverage(f);
    const claim = action(context, coverageId, f.accounts.payer.address, observed,
      encodeFunctionData({ abi: CORE_ABI, functionName: 'fileClaim', args: [coverageId, keccak256(toBytes('late evidence'))] }));
    await (f.evm.publicClient.request as any)({ method: 'anvil_increaseTime', params: [3601] });
    await (f.evm.publicClient.request as any)({ method: 'anvil_mine', params: ['0x1'] });
    let signatures = 0;
    const wallet = { chain: f.evm.walletClient.chain, async signTransaction(args: any) { signatures++; const { chain, account, ...tx } = args; return account.signTransaction({ ...tx, chainId: chain.id }); } };
    sender = await createActionSender({ context, actor: f.accounts.payer.address, client: f.evm.publicClient,
      wallet: wallet as any, account: f.evm.payer, journalPath: `${f.directory}/expired.json`, polls: 1, delay: 0 });
    await assert.rejects(() => sender!.submit(claim), /ACTION_STATE_INVALID/);
    assert.equal(signatures, 0);
    const journal = JSON.parse(await readFile(`${f.directory}/expired.json`, 'utf8'));
    assert.equal(journal.records.length, 0);
  } finally { await sender?.close().catch(() => undefined); await f.close(); }
});

test('a claim included as a canonical revert remains reconcilable without another broadcast', async () => {
  const f = await createPilotFixture();
  let sender: Awaited<ReturnType<typeof createActionSender>> | undefined;
  try {
    const context: BackendContext = { chainId: 84532, core: f.config.core, token: f.config.token,
      adjudicator: f.config.roles.adjudicator, serviceId: f.config.serviceId };
    const { coverageId, observed } = await openCoverage(f);
    const claim = action(context, coverageId, f.accounts.payer.address, observed,
      encodeFunctionData({ abi: CORE_ABI, functionName: 'fileClaim', args: [coverageId, keccak256(toBytes('expires after simulation'))] }));
    let signatures = 0; let broadcasts = 0;
    const client = new Proxy(f.evm.publicClient, { get(target, property) {
      if (property === 'sendRawTransaction') return async (args: any) => { broadcasts++; return f.evm.publicClient.sendRawTransaction(args); };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const wallet = { chain: f.evm.walletClient.chain, async signTransaction(args: any) {
      signatures++;
      await (f.evm.publicClient.request as any)({ method: 'anvil_increaseTime', params: [3601] });
      await (f.evm.publicClient.request as any)({ method: 'anvil_mine', params: ['0x1'] });
      const { chain, account, ...tx } = args;
      return account.signTransaction({ ...tx, chainId: chain.id });
    } };
    const path = `${f.directory}/canonical-revert.json`;
    sender = await createActionSender({ context, actor: f.accounts.payer.address, client, wallet: wallet as any,
      account: f.evm.payer, journalPath: path, polls: 2, delay: 0 });
    const reverted = await sender.submit(claim);
    assert.equal(reverted.status, 'reverted'); assert.equal(reverted.attempted, true);
    assert.equal(signatures, 1); assert.equal(broadcasts, 1);
    await sender.close(); sender = undefined;

    const recovered = await createActionSender({ context, actor: f.accounts.payer.address, client: f.evm.publicClient, journalPath: path, polls: 1, delay: 0 });
    const rows = await recovered.reconcile();
    assert.equal(rows.length, 1); assert.equal(rows[0]!.transaction, reverted.transaction); assert.equal(rows[0]!.status, 'reverted');
    assert.equal(signatures, 1); assert.equal(broadcasts, 1);
    await recovered.close();
  } finally { await sender?.close().catch(() => undefined); await f.close(); }
});

test('malformed signed transaction fields and a recovered wrong signer never reach broadcast', async () => {
  const f = await createPilotFixture();
  try {
    const context: BackendContext = { chainId: 84532, core: f.config.core, token: f.config.token,
      adjudicator: f.config.roles.adjudicator, serviceId: f.config.serviceId };
    const { coverageId, observed } = await openCoverage(f);
    const claim = action(context, coverageId, f.accounts.payer.address, observed,
      encodeFunctionData({ abi: CORE_ABI, functionName: 'fileClaim', args: [coverageId, keccak256(toBytes('signed fields'))] }));
    const mutations = [
      (tx: any) => ({ ...tx, nonce: tx.nonce + 1 }),
      (tx: any) => ({ ...tx, gas: tx.gas - 1n }),
      (tx: any) => ({ ...tx, maxFeePerGas: tx.maxFeePerGas - 1n }),
      (tx: any) => ({ ...tx, maxPriorityFeePerGas: tx.maxPriorityFeePerGas + 1n }),
      (tx: any) => ({ ...tx, value: 1n }),
      (tx: any) => ({ ...tx, to: f.accounts.provider.address }),
      (tx: any) => ({ ...tx, data: encodeFunctionData({ abi: CORE_ABI, functionName: 'token' }) }),
      (tx: any) => ({ ...tx, accessList: [{ address: f.accounts.provider.address, storageKeys: [] }] }),
    ];
    for (let i = 0; i < mutations.length; i++) {
      let broadcasts = 0; let signs = 0;
      const client = new Proxy(f.evm.publicClient, { get(target, property) {
        if (property === 'sendRawTransaction') return async () => { broadcasts++; throw new Error('must not broadcast'); };
        const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
      const mutate = mutations[i]!;
      const wallet = { chain: f.evm.walletClient.chain, async signTransaction(args: any) {
        signs++; const { chain, account, ...tx } = args; return account.signTransaction({ ...mutate(tx), chainId: chain.id });
      } };
      const path = `${f.directory}/bad-fields-${i}.json`;
      const sender = await createActionSender({ context, actor: f.accounts.payer.address, client, wallet: wallet as any,
        account: f.accounts.payer, journalPath: path, polls: 1, delay: 0 });
      await assert.rejects(() => sender.submit(claim), /ACTION_SIGNED_TRANSACTION_INVALID/);
      assert.equal(signs, 1); assert.equal(broadcasts, 0); assert.equal(JSON.parse(await readFile(path, 'utf8')).records.length, 0);
      await sender.close();
    }
    let broadcasts = 0;
    const client = new Proxy(f.evm.publicClient, { get(target, property) {
      if (property === 'sendRawTransaction') return async () => { broadcasts++; throw new Error('must not broadcast'); };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const wrongSigner = { chain: f.evm.walletClient.chain, async signTransaction(args: any) {
      const { chain, ...tx } = args; return f.evm.provider.signTransaction({ ...tx, chainId: chain.id });
    } };
    const path = `${f.directory}/bad-recovered-signer.json`;
    const sender = await createActionSender({ context, actor: f.accounts.payer.address, client, wallet: wrongSigner as any,
      account: f.accounts.payer, journalPath: path, polls: 1, delay: 0 });
    await assert.rejects(() => sender.submit(claim), /ACTION_SIGNED_TRANSACTION_INVALID/);
    assert.equal(broadcasts, 0); assert.equal(JSON.parse(await readFile(path, 'utf8')).records.length, 0);
    await sender.close();
  } finally { await f.close(); }
});

test('prepared-unsent journal entries stay stranded, and symlink journal parents are rejected', async () => {
  const f = await createPilotFixture();
  try {
    const context: BackendContext = { chainId: 84532, core: f.config.core, token: f.config.token,
      adjudicator: f.config.roles.adjudicator, serviceId: f.config.serviceId };
    const first = await openCoverage(f); const second = await openCoverage(f);
    const data = encodeFunctionData({ abi: CORE_ABI, functionName: 'fileClaim', args: [first.coverageId, keccak256(toBytes('stranded evidence'))] });
    const nonce = await f.evm.publicClient.getTransactionCount({ address: f.accounts.payer.address, blockTag: 'latest' });
    const journalPath = `${f.directory}/prepared-unsent.json`;
    await writeFile(journalPath, JSON.stringify({ version: 1, context, actor: f.accounts.payer.address.toLowerCase(), records: [{
      kind: 'fileClaim', coverageId: first.coverageId, transaction: keccak256(toBytes('crash after public identity fsync')), from: f.accounts.payer.address.toLowerCase(), to: context.core,
      nonce: String(nonce), calldataHash: keccak256(data), gas: '100000', maxFeePerGas: '100000000', maxPriorityFeePerGas: '1000000', value: '0', attempted: false,
    }] }), { mode: 0o600 });
    const sender = await createActionSender({ context, actor: f.accounts.payer.address, client: f.evm.publicClient, journalPath, polls: 1, delay: 0 });
    const recovered = await sender.reconcile(); assert.equal(recovered[0]!.attempted, false); assert.equal(recovered[0]!.status, undefined);
    const next = action(context, second.coverageId, f.accounts.payer.address, second.observed,
      encodeFunctionData({ abi: CORE_ABI, functionName: 'fileClaim', args: [second.coverageId, keccak256(toBytes('next claim'))] }));
    await assert.rejects(() => sender.submit(next), /ACTION_UNRESOLVED/);
    await sender.close();
    const existingAlias = `${f.directory}/existing-parent-link`; await symlink(f.directory, existingAlias);
    await assert.rejects(() => createActionSender({ context, actor:f.accounts.payer.address,client:f.evm.publicClient,journalPath:`${existingAlias}/prepared-unsent.json` }), /ACTION_JOURNAL_/);
    const realParent = `${f.directory}/journal-parent`; const linkedParent = `${f.directory}/journal-parent-link`;
    await import('node:fs/promises').then(({ mkdir }) => mkdir(realParent)); await symlink(realParent, linkedParent);
    const unsafe = await createActionSender({ context, actor: f.accounts.payer.address, client: f.evm.publicClient, journalPath: `${linkedParent}/bad.json` });
    await assert.rejects(() => unsafe.submit(next), /ACTION_JOURNAL_UNSAFE_PATH/);
    await unsafe.close();
  } finally { await f.close(); }
});

test('close drains queued submission and concurrent close callers release the actor lock once', async () => {
  const f = await createPilotFixture();
  let sender: Awaited<ReturnType<typeof createActionSender>> | undefined;
  try {
    const context: BackendContext = { chainId: 84532, core: f.config.core, token: f.config.token,
      adjudicator: f.config.roles.adjudicator, serviceId: f.config.serviceId };
    const { coverageId, observed } = await openCoverage(f);
    const claim = action(context, coverageId, f.accounts.payer.address, observed,
      encodeFunctionData({ abi: CORE_ABI, functionName: 'fileClaim', args: [coverageId, keccak256(toBytes('close race'))] }));
    let entered!: () => void; const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    let continueSimulation!: () => void; const simulationGate = new Promise<void>((resolve) => { continueSimulation = resolve; });
    const client = new Proxy(f.evm.publicClient, { get(target, property) {
      if (property === 'simulateContract') return async (args: any) => { entered(); await simulationGate; return f.evm.publicClient.simulateContract(args); };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const wallet = { chain: f.evm.walletClient.chain, async signTransaction(args: any) { const { chain, account, ...tx } = args; return account.signTransaction({ ...tx, chainId: chain.id }); } };
    sender = await createActionSender({ context, actor: f.accounts.payer.address, client, wallet: wallet as any,
      account: f.evm.payer, journalPath: `${f.directory}/close-race.json`, polls: 2, delay: 0 });
    const submission = sender.submit(claim);
    await enteredPromise;
    const closeOne = sender.close(); const closeTwo = sender.close();
    await assert.rejects(() => acquireActorLock(f.accounts.payer.address), /ACTION_LOCK_UNAVAILABLE/);
    continueSimulation();
    const result = await submission;
    assert.equal(result.status, 'success');
    await Promise.all([closeOne, closeTwo]); sender = undefined;
    const releaseConfirmed = await acquireActorLock(f.accounts.payer.address); await releaseConfirmed();
  } finally { await sender?.close().catch(() => undefined); await f.close(); }
});
