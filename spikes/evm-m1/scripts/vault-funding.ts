import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { createFundingRpc, createFundingSigner, runVaultFunding, type FundingSigner } from '../src/vault-funding.js';
import { VAULT_JOURNAL_DEFAULT_PATH } from '../src/vault-storage.js';
import { BASE_SEPOLIA_RPC } from '../src/preflight.js';

const args=process.argv.slice(2);
const execute=args.length===1&&args[0]==='--execute';
const readAddress=(value:string|undefined):Address=>{
  if(!value||!/^0x[0-9a-fA-F]{40}$/.test(value))throw new Error('M1_VAULT_FUNDING_CONFIGURATION');
  return value.toLowerCase() as Address;
};
async function main(){
  if(args.length!==0&&!execute)throw new Error('M1_VAULT_FUNDING_ARGUMENTS');
  const relayerAddress=readAddress(process.env.RELAYER_ADDRESS);
  const vaultAddress=readAddress(process.env.VAULT_ADDRESS);
  const journalPath=process.env.VAULT_FUNDING_JOURNAL_DIR??VAULT_JOURNAL_DEFAULT_PATH;
  const client=createFundingRpc(process.env.BASE_SEPOLIA_RPC_URL??BASE_SEPOLIA_RPC);
  const noSign:FundingSigner={address:relayerAddress,signTransaction:async()=>{throw new Error('M1_VAULT_FUNDING_CHECK_ONLY');}};
  const vaultNoSign:FundingSigner={address:vaultAddress,signTransaction:async()=>{throw new Error('M1_VAULT_FUNDING_CHECK_ONLY');}};
  let relayer=noSign,vault=vaultNoSign;
  if(execute){
    const relayerKey=process.env.RELAYER_PRIVATE_KEY as Hex|undefined;
    const vaultKey=process.env.VAULT_PRIVATE_KEY as Hex|undefined;
    if(!relayerKey||!vaultKey)throw new Error('M1_VAULT_FUNDING_SIGNER_CONFIGURATION');
    const ra=privateKeyToAccount(relayerKey),va=privateKeyToAccount(vaultKey);
    if(ra.address.toLowerCase()!==relayerAddress||va.address.toLowerCase()!==vaultAddress)throw new Error('M1_VAULT_FUNDING_SIGNER_IDENTITY');
    relayer=createFundingSigner(ra); vault=createFundingSigner(va);
  }
  const result=await runVaultFunding({client,relayer,vault,journalPath,execute,expectedRelayer:relayerAddress,expectedVault:vaultAddress});
  console.log(JSON.stringify(result));
  if(result.state==='pending'||result.state==='blocked')process.exitCode=2;
}
main().catch(error=>{const code=error instanceof Error&&/^M1_VAULT_FUNDING_[A-Z_]+$/.test(error.message)?error.message:'M1_VAULT_FUNDING_FAILED';console.error(code);process.exitCode=1;});
