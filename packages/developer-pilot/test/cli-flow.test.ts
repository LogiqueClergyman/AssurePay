import assert from 'node:assert/strict';
import test from 'node:test';
import { runLocalDemo } from '../src/local-demo.js';
test('clean local configuration and real CLI processes complete purchase, restart retrieval, claim and refund',async()=>{
 const result=await runLocalDemo();assert.equal(result.code,'LOCAL_PILOT_VERIFIED');assert.equal(result.buyerProcessRestart,true);assert.equal(result.retrievalRelayerNonceUnchanged,true);assert.equal(result.payerRefundDeltaAtomic,'3100');assert.equal(result.solvencyEquality,true);
});
