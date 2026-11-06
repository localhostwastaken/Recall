import test from 'node:test';
import assert from 'node:assert/strict';
import { History } from '../dist/database.js';
import { loadConfig } from '../dist/config.js';
import { inspectTransaction, retry } from '../dist/rpc.js';
const wallet = '0xd46480d1Ec02B8ce92aE383914026efD5F73f835';
const hash = '0x' + 'ab'.repeat(32);
test('configuration rejects wrong network and bad dry-run', () => {
  assert.throws(() => loadConfig({ GNOSIS_CHAIN_ID: '10200' }));
  assert.throws(() => loadConfig({ DRY_RUN: 'yes' }));
  assert.equal(loadConfig({}).dryRun, true);
});
test('history deduplicates hashes and tracks statuses', () => {
  const db = new History(':memory:');
  assert.equal(db.add(hash, wallet), true);
  assert.equal(db.add(hash.toUpperCase().replace('0X', '0x'), wallet), false);
  assert.equal(db.pending(wallet).length, 1);
  db.update(hash, 'failed', 'reverted');
  assert.equal(db.pending(wallet).length, 0);
  assert.equal(db.all(wallet)[0].status, 'failed');
  db.close();
});
test('receipt states do not imply faucet origin', async () => {
  const provider = { send: async () => '0x64', getTransaction: async () => ({to: wallet, value: 1n}), getTransactionReceipt: async () => null };
  assert.equal((await inspectTransaction(provider, wallet, hash)).status, 'pending');
  provider.getTransactionReceipt = async () => ({status: 0});
  assert.equal((await inspectTransaction(provider, wallet, hash)).status, 'failed');
  provider.getTransactionReceipt = async () => ({status: 1});
  const result = await inspectTransaction(provider, wallet, hash);
  assert.equal(result.status, 'confirmed_transfer');
  assert.match(result.detail, /Faucet origin is not verified/);
  provider.getTransaction = async () => ({to: wallet, value: 0n});
  assert.equal((await inspectTransaction(provider, wallet, hash)).status, 'unverified');
  provider.send = async () => '0x27d8';
  await assert.rejects(inspectTransaction(provider, wallet, hash), /Wrong RPC network/);
});
test('retry stops at success and respects limit', async () => {
  let calls = 0;
  assert.equal(await retry(async () => { if (++calls < 3) throw Error('temporary'); return 42; }, 3, 1), 42);
  assert.equal(calls, 3);
  await assert.rejects(retry(async () => { throw Error('down'); }, 2, 1), /down/);
});
