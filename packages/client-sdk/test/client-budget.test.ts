import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Budget } from '../src/budget.js';
import type { Hex } from 'viem';

const id = (n: string): Hex => `0x${n.repeat(64)}`;
async function fresh(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'assurepay-client-budget-'));
  await chmod(directory, 0o700);
  return directory;
}
async function rejected(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof Error && error.message === code);
}

test('budget enforces per-request, total and count limits and reserved admission blocks', async () => {
  const directory = await fresh();
  try {
    const budget = await Budget.open(directory, id('1'), '7', '10', 2);
    await budget.reserve({ requestId: id('2'), requestHash: id('3'), coverageId: id('4'), gross: '6' });
    await rejected(Promise.resolve().then(() => budget.assertAdmission()), 'CLIENT_SESSION_UNRESOLVED');
    await rejected(budget.reserve({ requestId: id('5'), requestHash: id('6'), coverageId: id('7'), gross: '2' }), 'CLIENT_SESSION_UNRESOLVED');
    await budget.mark(id('2'), 'authorized');
    await budget.mark(id('2'), 'attempted');
    await budget.mark(id('2'), 'confirmed');
    await rejected(budget.reserve({ requestId: id('5'), requestHash: id('6'), coverageId: id('7'), gross: '8' }), 'CLIENT_BUDGET_EXCEEDED');
    await budget.reserve({ requestId: id('5'), requestHash: id('6'), coverageId: id('7'), gross: '4' });
    await budget.mark(id('5'), 'authorized');
    await budget.mark(id('5'), 'attempted');
    await budget.mark(id('5'), 'confirmed');
    await rejected(budget.reserve({ requestId: id('8'), requestHash: id('9'), coverageId: id('a'), gross: '2' }), 'CLIENT_BUDGET_EXCEEDED');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('reopening preserves records and rejects changed namespace, missing state, corruption and symlinks', async () => {
  const directory = await fresh();
  try {
    const first = await Budget.open(directory, id('1'), '8', '20', 3);
    await first.reserve({ requestId: id('2'), requestHash: id('3'), coverageId: id('4'), gross: '5' });
    const reopened = await Budget.open(directory, id('1'), '8', '20', 3);
    assert.equal(reopened.get(id('2')).state, 'reserved');
    await rejected(Budget.open(directory, id('5'), '8', '20', 3), 'CLIENT_SESSION_INVALID');
  } finally { await rm(directory, { recursive: true, force: true }); }

  const missing = await fresh();
  try {
    await writeFile(join(missing, 'buyer.marker'), 'existing state', { mode: 0o600 });
    await rejected(Budget.open(missing, id('1'), '8', '20', 3), 'CLIENT_SESSION_MISSING');
  } finally { await rm(missing, { recursive: true, force: true }); }

  const corrupt = await fresh();
  try {
    await writeFile(join(corrupt, 'session.json'), '{invalid', { mode: 0o600 });
    await rejected(Budget.open(corrupt, id('1'), '8', '20', 3), 'CLIENT_SESSION_INVALID');
  } finally { await rm(corrupt, { recursive: true, force: true }); }

  const linked = await fresh();
  const target = join(linked, 'target.json');
  try {
    await writeFile(target, JSON.stringify({ version: 1, namespace: id('1'), requests: [] }), { mode: 0o600 });
    await symlink(target, join(linked, 'session.json'));
    await rejected(Budget.open(linked, id('1'), '8', '20', 3), 'CLIENT_SESSION_INVALID');
  } finally { await rm(linked, { recursive: true, force: true }); }
});

test('session reopens only with the same cap namespace and rejects malformed or over-limit records', async () => {
  const directory = await fresh();
  try {
    await Budget.open(directory, id('1'), '8', '20', 3);
    await rejected(Budget.open(directory, id('5'), '8', '20', 3), 'CLIENT_SESSION_INVALID');
  } finally { await rm(directory, { recursive: true, force: true }); }

  const invalid = await fresh();
  try {
    await writeFile(join(invalid, 'session.json'), JSON.stringify({ version: 1, namespace: id('1'), requests: [
      { requestId: id('2'), requestHash: id('3'), coverageId: id('4'), gross: (1n << 256n).toString(), state: 'reserved' },
    ] }), { mode: 0o600 });
    await rejected(Budget.open(invalid, id('1'), '8', '20', 3), 'CLIENT_SESSION_INVALID');
    const raw = await readFile(join(invalid, 'session.json'), 'utf8');
    assert.ok(raw.includes('reserved'));
  } finally { await rm(invalid, { recursive: true, force: true }); }
});

test('per-payment cap rejects a request above maxGross without persisting it', async () => {
  const directory = await fresh();
  try {
    const budget = await Budget.open(directory, id('1'), '7', '20', 3);
    await rejected(budget.reserve({ requestId: id('2'), requestHash: id('3'), coverageId: id('4'), gross: '8' }), 'CLIENT_BUDGET_EXCEEDED');
    await assert.rejects(Promise.resolve().then(() => budget.get(id('2'))), { message: 'CLIENT_REQUEST_UNKNOWN' });
    const reopened = await Budget.open(directory, id('1'), '7', '20', 3);
    await assert.rejects(Promise.resolve().then(() => reopened.get(id('2'))), { message: 'CLIENT_REQUEST_UNKNOWN' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
