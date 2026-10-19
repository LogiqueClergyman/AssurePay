import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { decodeFunctionData } from 'viem';
import { fixture, expectInvariant, OUTCOME } from '../test/helpers/fixture.js';
import { compileContracts, transact, attemptRevert } from '../test/helpers/evm.js';

// Isolated Anvil only: no environment loading, public RPC or persisted signers.
try {
  const f = await fixture({ secondProviderStake: 50_000n });
  try {
    const gas: Record<string, string> = {};
    const head = await f.evm.publicClient.getBlockNumber();
    for (let height=1n; height<=head; height++) {
      const block = await f.evm.publicClient.getBlock({ blockNumber: height, includeTransactions: true });
      for (const transaction of block.transactions) {
        const receipt = await f.evm.publicClient.getTransactionReceipt({ hash: transaction.hash });
        if (receipt.contractAddress?.toLowerCase()===f.core.toLowerCase()) gas.deploy=String(receipt.gasUsed);
        else if (transaction.to?.toLowerCase()===f.core.toLowerCase()) {
          const decoded=decodeFunctionData({abi:f.coreAbi,data:transaction.input});
          gas[String(decoded.functionName)]??=String(receipt.gasUsed);
        }
      }
    }
    const ids: `0x${string}`[]=[];
    for(const [name,outcome] of [['providerFault',OUTCOME.providerFault],['poolOnly',OUTCOME.poolOnly],['rejection',OUTCOME.reject]] as const){
      const input=await f.createIntent({gross:10_003n}); ids.push(input.coverageId);
      const settled=await f.settle(input); gas.settleAssured??=String(settled.gasUsed);
      gas.fileClaim=String((await transact(f.evm,f.coreAbi,f.core,'fileClaim',[input.coverageId,`0x${'01'.repeat(32)}`],input.payer)).gasUsed);
      gas[name]=String((await transact(f.evm,f.coreAbi,f.core,'finalizeClaim',[input.coverageId,outcome,outcome===OUTCOME.reject?0n:10_003n,`0x${'02'.repeat(32)}`],f.evm.outsider)).gasUsed);
      await expectInvariant(f,[f.providerId,f.secondProviderId],ids);
    }
    const expiring=await f.createIntent();ids.push(expiring.coverageId);await f.settle(expiring);
    const coverage=await f.coverage(expiring.coverageId);
    await f.evm.publicClient.request({method:'evm_setNextBlockTimestamp',params:[Number(coverage.expiresAt)]});
    gas.closeExpired=String((await transact(f.evm,f.coreAbi,f.core,'closeExpired',[expiring.coverageId])).gasUsed);
    gas.withdrawStake=String((await transact(f.evm,f.coreAbi,f.core,'withdrawStake',[f.providerId,1n],f.evm.provider)).gasUsed);
    gas.includedDuplicateRevert=String((await attemptRevert(f.evm,f.coreAbi,f.core,'closeExpired',[expiring.coverageId])).gasUsed);
    await expectInvariant(f,[f.providerId,f.secondProviderId],ids);
    const artifact=compileContracts().AssuranceCore!;
    const source={creationBytes:(artifact.bytecode.length-2)/2,creationSha256:createHash('sha256').update(Buffer.from(artifact.bytecode.slice(2),'hex')).digest('hex'),runtimeTemplateBytes:(artifact.deployedBytecode.length-2)/2};
    const report={code:'M2_LOCAL_EVM_MEASURED',chain:'isolated-anvil-84532',token:'faithful local ERC3009 fixture; not public USDC',gasUsed:gas,artifact:source,limits:['gas depends on fixture state and compiler settings','runtime template has constructor-patched immutables','no public new-Core deployment or production audit']};
    await mkdir(new URL('../evidence/',import.meta.url),{recursive:true});
    await writeFile(new URL('../evidence/local-execution.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report));
  } finally {await f.close();}
} catch { console.error('M2_LOCAL_MEASUREMENT_FAILED');process.exitCode=1; }
