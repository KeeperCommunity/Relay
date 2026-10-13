const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ts = require('typescript');
const { createFixture } = require('../support/automaticBackupHttpFixture.cjs');

// Use the exact mobile AES functions, including real salt/randomness. Extract
// only these pure exports; native RSA is unrelated to encrypted backups.
const keeperRoot = process.env.KEEPER_APP_SOURCE;
assert.ok(keeperRoot, 'Set KEEPER_APP_SOURCE to the compatible app checkout');
const appRequire = createRequire(path.join(keeperRoot, 'package.json'));
const encryptionFile = path.join(keeperRoot, 'src/utils/service-utilities/encryption.ts');
const encryptionText = fs.readFileSync(encryptionFile, 'utf8');
const encryptionTree = ts.createSourceFile(encryptionFile, encryptionText, ts.ScriptTarget.Latest, true);
const declarations = encryptionTree.statements.filter(statement => ts.isVariableStatement(statement) &&
  statement.declarationList.declarations.some(declaration => ['encrypt', 'decrypt'].includes(declaration.name.getText(encryptionTree))));
assert.equal(declarations.length, 2);
const cryptoModule = { exports: {} };
const cryptoCode = ts.transpileModule(declarations.map(node => node.getText(encryptionTree)).join('\n'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
vm.runInThisContext(`(function(module,exports,cryptoJS){${cryptoCode}\n})`, { filename: encryptionFile })
  (cryptoModule, cryptoModule.exports, appRequire('crypto-js'));
const key = 'disposable-http-backup-key';
const cipher = record => cryptoModule.exports.encrypt(key, JSON.stringify(record));
const decode = encrypted => JSON.parse(cryptoModule.exports.decrypt(key, encrypted));
const wallet = { id: 'wallet', name: 'before', networkType: 'TESTNET' };
const signer = { masterFingerprint: 'aabbccdd', name: 'before' };
const vault = { id: 'vault', name: 'before', archived: false };
const label = { id: 'tag', label: 'before' };
const changed = { name: 'after' };
const operations = {
  updateAppImage: () => ({ walletsObject: { wallet: cipher({ ...wallet, ...changed }) } }),
  migrateXfps: () => ({ signerChanges: [{ oldSignerId: 'old-key', newSignerId: 'new-key',
    newSignerDetails: cipher({ ...signer, ...changed }) }] }),
  deleteAppImageEntity: () => ({ walletIds: ['wallet'], signers: [] }),
  deleteVaults: () => ({ vaults: ['vault'] }),
  updateVaultImage: () => ({ isUpdate: true, vaultId: 'vault', vault: cipher({ ...vault, ...changed }),
    isArchived: false, signersData: [] }),
  modifyLabels: () => ({ addLabels: [{ id: 'tag', content: cipher({ ...label, ...changed }) }], deleteLabels: [] }),
  deleteBackup: () => ({}),
};
let fixture;
before(async () => { fixture = await createFixture(); });
after(async () => { if (fixture) await fixture.close(); });
async function baseline(operation, suffix) {
  await fixture.reset();
  const appId = `synthetic-${operation}-${suffix}`;
  const snapshot = await fixture.seed({ appId, walletObject: { wallet: cipher(wallet),
    remote: cipher({ id: 'remote', name: 'remote-only', networkType: 'TESTNET' }) },
    signersObject: { 'old-key': cipher(signer) },
    vaultObject: { vault: { vaultId: 'vault', vault: cipher(vault), isArchived: false, signersData: [] } },
    nodes: [], labels: [{ id: 'tag', content: cipher(label) }] });
  fixture.clearTrace();
  return { appId, snapshot, body: { appId, expectedRevision: snapshot.revision,
    operation, ...operations[operation]() } };
}
function checkEffect(operation, snapshot) {
  if (operation === 'updateAppImage') assert.equal(decode(snapshot.appImage.wallets.wallet).name, 'after');
  if (operation === 'migrateXfps') {
    assert.equal(snapshot.appImage.signers['old-key'], undefined);
    assert.equal(decode(snapshot.appImage.signers['new-key']).name, 'after');
  }
  if (operation === 'deleteAppImageEntity') assert.equal(snapshot.appImage.wallets.wallet, undefined);
  if (operation === 'deleteVaults') assert.equal(snapshot.allVaultImages.length, 0);
  if (operation === 'updateVaultImage') assert.equal(decode(snapshot.allVaultImages[0].vault).name, 'after');
  if (operation === 'modifyLabels') assert.equal(decode(snapshot.labels[0].content).name, 'after');
  if (operation === 'deleteBackup') {
    assert.deepEqual(snapshot.appImage.wallets, {});
    assert.deepEqual(snapshot.appImage.signers, {});
    assert.equal(snapshot.allVaultImages.length, 0);
    assert.equal(snapshot.labels.length, 0);
  } else assert.equal(decode(snapshot.appImage.wallets.remote).name, 'remote-only');
}

for (const operation of Object.keys(operations)) {
  test(`${operation}: real HTTP CAS acknowledges transaction and encrypted readback`, async () => {
    const input = await baseline(operation, 'ack');
    const result = await fixture.post('revisionedBackupMutation', input.body);
    assert.deepEqual(Object.keys(result.data).sort(), ['newRevision', 'preconditionApplied', 'updated']);
    assert.equal(result.data.updated, true);
    assert.equal(result.data.preconditionApplied, true);
    assert.match(result.data.newRevision, /^[a-f0-9]{64}$/);
    assert.notEqual(result.data.newRevision, input.snapshot.revision);
    const snapshot = await fixture.snapshot(input.appId);
    assert.equal(result.data.newRevision, snapshot.revision);
    checkEffect(operation, snapshot);
    await fixture.post('revisionedBackupMutation', input.body, 409);
    assert.equal((await fixture.snapshot(input.appId)).revision, snapshot.revision);
  });
  for (const mode of ['409', '404', 'malformed', 'lost-reply']) {
    test(`${operation}: ${mode} uses actual transaction outcome without fake CAS success`, async () => {
      const input = await baseline(operation, mode);
      fixture.armFault({ mode, operation });
      if (mode === 'lost-reply') await assert.rejects(fixture.post('revisionedBackupMutation', input.body));
      else {
        const result = await fixture.post('revisionedBackupMutation', input.body,
          mode === '409' ? 409 : mode === '404' ? 404 : 200);
        if (mode === '409') assert.equal(result.data.error, 'BACKUP_CHANGED');
        if (mode === 'malformed') assert.equal(result.data.newRevision, 'invalid');
      }
      const snapshot = await fixture.snapshot(input.appId);
      const attempts = fixture.trace.filter(entry => entry.path === '/revisionedBackupMutation');
      assert.equal(attempts.length, 1);
      if (mode === '404') {
        assert.equal(attempts[0].routeInvoked, false);
        assert.equal(snapshot.revision, input.snapshot.revision);
      } else if (mode === '409') {
        assert.equal(attempts[0].committed, false);
        assert.notEqual(snapshot.revision, input.snapshot.revision);
        assert.equal(snapshot.appImage.wallets.wallet, input.snapshot.appImage.wallets.wallet);
      } else {
        assert.equal(attempts[0].committed, true);
        assert.notEqual(snapshot.revision, input.snapshot.revision);
        checkEffect(operation, snapshot);
      }
    });
  }
}

test('fanout fault skips the first commit and faults the next real acknowledgement', async () => {
  const input = await baseline('updateAppImage', 'fanout');
  fixture.armFault({ mode: 'malformed', operation: 'updateAppImage', after: 1 });
  const first = await fixture.post('revisionedBackupMutation', input.body);
  assert.match(first.data.newRevision, /^[a-f0-9]{64}$/);
  const next = { ...input.body, expectedRevision: first.data.newRevision,
    walletsObject: { wallet: cipher({ ...wallet, name: 'second' }) } };
  const second = await fixture.post('revisionedBackupMutation', next);
  assert.equal(second.data.newRevision, 'invalid');
  const snapshot = await fixture.snapshot(input.appId);
  assert.equal(decode(snapshot.appImage.wallets.wallet).name, 'second');
  assert.equal(fixture.trace.filter(entry => entry.committed).length, 2);
});

test('snapshot reply barrier permits a real peer transaction after read and before delivery', async () => {
  const input = await baseline('updateAppImage', 'snapshot-barrier');
  let callbackCompleted = false;
  fixture.armFault({ mode: 'before-snapshot-reply', beforeReply: async ({ body, service, db }) => {
    await service.withBackupMutation(input.appId, async session => {
      await db.getAppImageModel().updateOne({ appId: input.appId }, {
        $set: { 'wallets.peer': cipher({ id: 'peer', name: 'concurrent-peer', networkType: 'TESTNET' }) },
      }, { session });
      return { updated: true };
    }, body.revision, true);
    callbackCompleted = true;
  } });
  const delayedSnapshot = await fixture.snapshot(input.appId);
  assert.equal(callbackCompleted, true);
  assert.equal(delayedSnapshot.revision, input.snapshot.revision);
  const actual = await fixture.snapshot(input.appId);
  assert.notEqual(actual.revision, delayedSnapshot.revision);
  assert.equal(decode(actual.appImage.wallets.peer).name, 'concurrent-peer');
  await fixture.post('revisionedBackupMutation', input.body, 409);
  assert.equal((await fixture.snapshot(input.appId)).revision, actual.revision);
});
