import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPilot } from '../src/provider.js';
import { createProtocolFixture } from '../../protocol-app/test/helpers.js';

test('protocol provider seam accepts its separate admin while legacy default still expects relayer', async (t) => {
  const f = await createProtocolFixture();
  t.after(() => f.close());
  await assert.rejects(() => checkPilot(f.config.pilot, f.evm.publicClient), /PILOT_CONTEXT_MISMATCH/);
  const terms = await checkPilot(f.config.pilot, f.evm.publicClient, f.config.admin);
  assert.equal(terms.core.toLowerCase(), f.config.pilot.core);
  assert.equal(terms.providerOwner.toLowerCase(), f.config.pilot.roles.provider);
  assert.equal(terms.providerPayout.toLowerCase(), f.config.pilot.roles.provider);
});
