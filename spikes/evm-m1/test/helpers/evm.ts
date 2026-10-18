import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import {
  createPublicClient, createWalletClient, http, parseSignature,
  type Address, type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { buildReceiveWithAuthorization, hashIntent, type Intent } from '../../src/intent.js';

import type { Artifact } from '../../src/compiler.js';
export { compileContracts, type Artifact } from '../../src/compiler.js';
export interface Evm {
  publicClient: any;
  walletClient: any;
  owner: PrivateKeyAccount;
  payer: PrivateKeyAccount;
  provider: PrivateKeyAccount;
  outsider: PrivateKeyAccount;
  url: string;
  close(): Promise<void>;
}

async function port(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error();
    await new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes()));
    return address.port;
  } catch { throw new Error('LOCAL_EVM_PORT_UNAVAILABLE'); }
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit').catch(() => undefined);
  child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 1500); })]);
  if (timer) clearTimeout(timer);
  if (child.exitCode === null) child.kill('SIGKILL');
}

/** Isolated chain, no unlocked default accounts; ephemeral keys remain inside account closures. */
export async function startEvm(): Promise<Evm> {
  const localPort = await port();
  const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(localPort), '--chain-id', '84532',
    '--hardfork', 'cancun', '--accounts', '0', '--silent'], { stdio: 'ignore' });
  let spawnFailed = false;
  child.on('error', () => { spawnFailed = true; });
  const url = `http://127.0.0.1:${localPort}`;
  const transport = http(url, { timeout: 1000, retryCount: 0 });
  const publicClient = createPublicClient({ chain: baseSepolia, transport, pollingInterval: 10 });
  let ready = false;
  for (let i = 0; i < 60 && !spawnFailed && child.exitCode === null; i++) {
    try { if (await publicClient.getChainId() === 84532) { ready = true; break; } } catch { /* startup only */ }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  if (!ready) { await stop(child); throw new Error('LOCAL_EVM_START_FAILED'); }
  const [owner, payer, provider, outsider] = Array.from({ length: 4 }, () => privateKeyToAccount(generatePrivateKey()));
  if (!owner || !payer || !provider || !outsider) throw new Error('LOCAL_ACCOUNT_CREATION_FAILED');
  try {
    for (const account of [owner, payer, provider, outsider]) {
      await (publicClient.request as any)({ method: 'anvil_setBalance', params: [account.address, '0xde0b6b3a7640000'] });
    }
  } catch { await stop(child); throw new Error('LOCAL_ACCOUNT_FUNDING_FAILED'); }
  return { publicClient, walletClient: createWalletClient({ chain: baseSepolia, transport }),
    owner, payer, provider, outsider, url, close: () => stop(child) };
}

export async function deploy(evm: Evm, artifact: Artifact, args: readonly unknown[] = []): Promise<Address> {
  try {
    const hash = await evm.walletClient.deployContract({ ...artifact, args, account: evm.owner, gas: 6_000_000n });
    const receipt = await evm.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error();
    return receipt.contractAddress;
  } catch { throw new Error('LOCAL_DEPLOYMENT_FAILED'); }
}

async function send(evm: Evm, abi: any, address: Address, functionName: string,
  args: readonly unknown[] = [], account = evm.owner): Promise<any> {
  try {
    const hash = await evm.walletClient.writeContract({ abi, address, functionName, args, account, gas: 2_000_000n });
    return await evm.publicClient.waitForTransactionReceipt({ hash });
  } catch { throw new Error('LOCAL_SUBMISSION_OR_CONFIRMATION_FAILED'); }
}
export async function transact(evm: Evm, abi: any, address: Address, functionName: string,
  args: readonly unknown[] = [], account = evm.owner): Promise<any> {
  const receipt = await send(evm, abi, address, functionName, args, account);
  if (receipt.status !== 'success') throw new Error(`LOCAL_EXPECTED_SUCCESS_${functionName}`);
  return receipt;
}
export async function attemptRevert(evm: Evm, abi: any, address: Address, functionName: string,
  args: readonly unknown[] = [], account = evm.owner): Promise<any> {
  const receipt = await send(evm, abi, address, functionName, args, account);
  if (receipt.status !== 'reverted') throw new Error(`LOCAL_EXPECTED_REVERT_${functionName}`);
  return receipt;
}
function split(signature: Hex) {
  const parsed = parseSignature(signature);
  return { signature, r: parsed.r, s: parsed.s, v: Number(parsed.v ?? BigInt((parsed.yParity ?? 0) + 27)) };
}
export async function signReceive(payer: PrivateKeyAccount, intent: Intent) {
  try {
    const typed = buildReceiveWithAuthorization(intent, hashIntent(intent), {
      name: 'USDC', version: '2', chainId: BigInt(intent.chainId), token: intent.token,
    });
    return split(await payer.signTypedData(typed));
  } catch { throw new Error('LOCAL_RECEIVE_SIGNING_FAILED'); }
}
export async function signTransfer(payer: PrivateKeyAccount, intent: Intent) {
  try {
    const typed = buildReceiveWithAuthorization(intent, hashIntent(intent), {
      name: 'USDC', version: '2', chainId: BigInt(intent.chainId), token: intent.token,
    });
    return split(await payer.signTypedData({ ...typed, primaryType: 'TransferWithAuthorization',
      types: { TransferWithAuthorization: typed.types.ReceiveWithAuthorization } }));
  } catch { throw new Error('LOCAL_TRANSFER_SIGNING_FAILED'); }
}
export async function signCancel(authorizer: PrivateKeyAccount, token: Address, nonce: Hex, chainId = 84532n) {
  try {
    return split(await authorizer.signTypedData({
      domain: { name: 'USDC', version: '2', chainId, verifyingContract: token },
      primaryType: 'CancelAuthorization', types: { CancelAuthorization: [
        { name: 'authorizer', type: 'address' }, { name: 'nonce', type: 'bytes32' },
      ] }, message: { authorizer: authorizer.address, nonce },
    }));
  } catch { throw new Error('LOCAL_CANCEL_SIGNING_FAILED'); }
}
export function solidityIntent(intent: Intent) {
  return { ...intent, chainId: BigInt(intent.chainId), gross: BigInt(intent.gross),
    validAfter: BigInt(intent.validAfter), validBefore: BigInt(intent.validBefore) };
}
