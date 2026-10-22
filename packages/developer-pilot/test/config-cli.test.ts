import assert from 'node:assert/strict';
import test from 'node:test';
import { generatePrivateKey,privateKeyToAccount } from 'viem/accounts';
import { validateConfig } from '../src/config.js';
import { runCli } from '../src/cli.js';
const a=()=>privateKeyToAccount(generatePrivateKey()).address;
const config=()=>({version:1,mode:'local',chainId:84532,rpcUrl:'http://127.0.0.1:8545',core:a(),token:a(),providerId:`0x${'11'.repeat(32)}`,policyId:`0x${'22'.repeat(32)}`,serviceId:`0x${'33'.repeat(32)}`,roles:{relayer:a(),payer:a(),provider:a(),adjudicator:a()},resourceUrl:'http://127.0.0.1:8080/service',claimsUrl:'http://127.0.0.1:8081',deploymentBlock:'0',gross:'10003'});
test('local configuration rejects public RPC/token, wrong roles, floats and extra fields',()=>{
 const c=config();assert.equal(validateConfig(c).gross,'10003');
 for(const bad of [{...c,rpcUrl:'https://sepolia.base.org'},{...c,token:'0x036cbd53842c5426634e7929541ec2318f3dcf7e'},{...c,roles:{...c.roles,payer:c.roles.relayer}},{...c,gross:0.01},{...c,unknown:true}])assert.throws(()=>validateConfig(bad));
});
test('financial CLI guards reject absent execution and ambiguous flags before configuration or signer loading',async()=>{
 for(const command of ['purchase','claim','decision'])await assert.rejects(()=>runCli([command,'--config','missing'],{},()=>{throw Error('unexpected output');}),/PILOT_EXPLICIT_EXECUTE_REQUIRED/);
 for(const input of [['unknown'],['purchase','--execute','--execute'],['check','--config','one','--config','two'],['check','--secret','value']])await assert.rejects(()=>runCli(input,{},()=>{}),/PILOT_ARGUMENTS_INVALID/);
});
