import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPilotFixture, freePort } from '../../developer-pilot/test/helpers.js';
import { deploy, transact } from '../../evm-core/test/helpers/evm.js';
import { validateProtocolConfig } from '../src/config.js';

/** Every actor and both Cores in this disposable fixture are newly generated locally. */
export async function createProtocolFixture() {
  const f = await createPilotFixture();
  try {
    const adminKey = generatePrivateKey(), admin = privateKeyToAccount(adminKey);
    await f.evm.publicClient.request({ method: 'anvil_setBalance', params: [admin.address, '0xde0b6b3a7640000'] });
    const core = await deploy(f.evm, f.artifacts.AssuranceCore, [f.config.token, admin.address, f.accounts.adjudicator.address]);
    const deploymentBlock = await f.evm.publicClient.getBlockNumber();
    const token = f.config.token, abi = f.artifacts.AssuranceCore.abi, tokenAbi = f.artifacts.AuthorizationTokenMock.abi;
    await transact(f.evm, tokenAbi, token, 'mint', [f.accounts.payer.address, 60000n]);
    await transact(f.evm, tokenAbi, token, 'mint', [admin.address, 100000n]);
    await transact(f.evm, tokenAbi, token, 'mint', [f.accounts.provider.address, 100000n]);
    await transact(f.evm, abi, core, 'registerProvider', [f.config.providerId, f.accounts.provider.address, f.accounts.provider.address], admin);
    await transact(f.evm, abi, core, 'registerPolicy', [f.config.policyId, f.config.providerId, 777, 3500, 2200, 3600n, true], admin);
    await transact(f.evm, tokenAbi, token, 'approve', [core, 60000n], f.accounts.payer);
    await transact(f.evm, abi, core, 'depositStake', [f.config.providerId, 10000n], f.accounts.payer);
    await transact(f.evm, abi, core, 'fundPool', [50000n], f.accounts.payer);
    const config = validateProtocolConfig({ version: 1, pilot: { ...f.config, core, deploymentBlock: String(deploymentBlock) },
      admin: admin.address, apiUrl: `http://127.0.0.1:${await freePort()}` });
    return { ...f, config, pilotConfig: config.pilot, accounts: { ...f.accounts, admin },
      roleKeys: { ...f.roleKeys, admin: adminKey } };
  } catch (error) { await f.close(); throw error; }
}
