import assert from 'node:assert/strict';
import test from 'node:test';
import { runProtocolFlow } from './integration-flow.js';

test('actual role-bound API controls, private adjudication, canonical accounting and signer-free original recovery',async()=>{
  const report=await runProtocolFlow(); assert.equal(report.ok,true); assert.equal(report.code,'LOCAL_PROTOCOL_API_VERIFIED');
});
