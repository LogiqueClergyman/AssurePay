import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeDeployData, keccak256, type Hex } from 'viem';
import { prepareCoreCall } from '../src/call.js';
import { demoConfiguration, DEMO_TERMS } from '../src/demo.js';
import { hashIntent, type Intent } from '../src/intent.js';
import { NATIVE_USDC } from '../src/preflight.js';
import { buildRequirements } from '../src/profile.js';
import { verifyPublicAdmissionRevert, verifyPublicDeployment, verifyPublicSuccess } from '../src/public-proof.js';
import { attemptRevert, compileContracts, deploy, signReceive, startEvm, transact } from './helpers/evm.js';

test('public proof readers verify actual local deployment/split/valid-signature admission revert', async () => {
  const evm = await startEvm();
  try {
    const artifacts = compileContracts();
    const tokenArtifact = artifacts.AuthorizationTokenMock!;
    const coreArtifact = artifacts.AssuranceCoreSpike!;
    // Local-only fixture at the public address; this is NOT native USDC or public-chain evidence.
    const localToken = await deploy(evm, tokenArtifact);
    const code = await evm.publicClient.getCode({ address: localToken });
    await evm.publicClient.request({ method: 'anvil_setCode', params: [NATIVE_USDC, code] });
    await transact(evm, tokenArtifact.abi, NATIVE_USDC, 'mint', [evm.payer.address, 200n]);
    const deploymentInput = encodeDeployData({ ...coreArtifact, args: [NATIVE_USDC, evm.provider.address,
      DEMO_TERMS.providerId, DEMO_TERMS.policyId, DEMO_TERMS.policyHash] });
    const deploymentHash = await evm.walletClient.sendTransaction({ account: evm.owner, data: deploymentInput, gas: 2_000_000n });
    const receipt = await evm.publicClient.waitForTransactionReceipt({ hash: deploymentHash });
    const core = receipt.contractAddress;
    const deployment = await verifyPublicDeployment(evm.publicClient, { transaction: deploymentHash,
      relayer: evm.owner.address, providerPayout: evm.provider.address });
    assert.equal(deployment.ok, true);
    assert.equal(deployment.core, core);
    const configuration = demoConfiguration(core, evm.provider.address);
    const purchase = async (salt: string) => {
      const now = (await evm.publicClient.getBlock()).timestamp as bigint;
      const intent: Intent = { ...DEMO_TERMS, chainId: '84532', core: core.toLowerCase(),
        token: NATIVE_USDC.toLowerCase() as Hex, payer: evm.payer.address.toLowerCase() as Hex, gross: '100',
        payerSalt: `0x${salt.repeat(32)}`, validAfter: String(now - 1n), validBefore: String(now + 299n) };
      const signature = await signReceive(evm.payer, intent);
      const call = await prepareCoreCall({ x402Version: 2, accepted: buildRequirements(configuration),
        payload: { intent, intentHash: hashIntent(intent), signature: signature.signature } }, configuration, now);
      return { call, intent };
    };
    const first = await purchase('a1');
    const firstHash = await evm.walletClient.sendTransaction({ account: evm.owner, to: core, data: first.call.data, gas: 500_000n });
    await evm.publicClient.waitForTransactionReceipt({ hash: firstHash });
    const expected = { transaction: firstHash, core, payer: evm.payer.address, relayer: evm.owner.address,
      providerPayout: evm.provider.address, calldataHash: keccak256(first.call.data) };
    const success = await verifyPublicSuccess(evm.publicClient, expected);
    assert.equal(success.ok, true);
    assert.deepEqual('tokenDeltas' in success ? success.tokenDeltas : [], ['-100', '7', '93']);
    assert.equal((await verifyPublicSuccess(evm.publicClient, { ...expected, payer: evm.outsider.address })).ok, false);
    assert.equal((await verifyPublicSuccess(evm.publicClient, { ...expected, minimumConfirmations: 2n })).ok, false);
    await transact(evm, coreArtifact.abi, core, 'setAdmissionEnabled', [false]);
    const second = await purchase('b2');
    const revertHash = await evm.walletClient.sendTransaction({ account: evm.owner, to: core, data: second.call.data, gas: 500_000n });
    await evm.publicClient.waitForTransactionReceipt({ hash: revertHash });
    const rollback = await verifyPublicAdmissionRevert(evm.publicClient, { ...expected,
      transaction: revertHash, calldataHash: keccak256(second.call.data) });
    assert.equal(rollback.ok, true);
    assert.equal((await verifyPublicAdmissionRevert(evm.publicClient, expected)).ok, false);
    assert.equal((await verifyPublicDeployment(evm.publicClient, { transaction: deploymentHash,
      relayer: evm.outsider.address, providerPayout: evm.provider.address })).ok, false);
  } finally { await evm.close(); }
});
