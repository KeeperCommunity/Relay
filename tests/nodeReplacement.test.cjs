const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const mongoose = require('mongoose');
// No .env or integration configuration: this suite can touch only its own
// uniquely named disposable loopback database on the Keeper QA replica set.
const database = `keeper_node_replacement_test_${process.pid}`;
const uri = require('./disposableMongo.cjs').testMongoUri('keeper_node_replacement_test');
function load(file, mocks = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, global, console,
    require: name => name in mocks ? mocks[name] : require(name) });
  return module.exports;
}
const db = load('src/db.ts', { './config': { DATABASE: uri }, './interface': { NotificationType: { RELEASE_MESSAGE: 'RELEASE_MESSAGE' } } }).default;
const service = load('src/services/bhr.ts', { './backupSnapshot': load('src/services/backupSnapshot.ts', { '../db': db }), '../db': db, '../interface': {}, './app': { getAppSubscriptionDetails: async () => null }, '../utils/plans': { getPlans: () => [] } });
let app;
before(async () => {
  await new Promise((resolve, reject) => {
    if (mongoose.connection.readyState === 1) return resolve();
    mongoose.connection.once('open', resolve); mongoose.connection.once('error', reject);
  });
  app = db.getAppImageModel(); await app.init();
});
after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
async function seed(id) {
  await app.create({ appId: id, publicId: `public-${id}`, version: '2.5.16',
    wallets: { existing: 'encrypted-wallet' }, signers: { existing: 'encrypted-signer' },
    nodes: ['encrypted-node'], vaults: [], labels: [] });
}
const stored = id => app.findOne({ appId: id }).lean();

test('explicit empty node replacement removes the final backed-up node', async () => {
  await seed('clear');
  assert.equal((await service.updateAppImage('clear', null, null, null, null, null, [], true)).updated, true);
  const record = await stored('clear');
  assert.deepEqual(record.nodes, []);
  assert.equal(record.wallets.existing, 'encrypted-wallet');
  assert.equal(record.signers.existing, 'encrypted-signer');
});

for (const flag of [undefined, false]) test(`unrelated wallet/key updates with empty nodes preserve saved nodes: ${flag}`, async () => {
  const id = `unrelated-${flag}`; await seed(id);
  assert.equal((await service.updateAppImage(id, null, { added: 'new-wallet' }, null, '2.5.17', { added: 'new-signer' }, [], flag)).updated, true);
  const record = await stored(id);
  assert.deepEqual(record.nodes, ['encrypted-node']);
  assert.equal(record.wallets.added, 'new-wallet'); assert.equal(record.signers.added, 'new-signer');
});

test('legacy nonempty node updates retain their previous behavior', async () => {
  await seed('legacy');
  assert.equal((await service.updateAppImage('legacy', null, null, null, null, null, ['legacy-new-node'])).updated, true);
  assert.deepEqual((await stored('legacy')).nodes, ['legacy-new-node']);
});

test('explicit nonempty replacement stores the new list', async () => {
  await seed('replace');
  assert.equal((await service.updateAppImage('replace', null, null, null, null, null, ['one', 'two'], true)).updated, true);
  assert.deepEqual((await stored('replace')).nodes, ['one', 'two']);
});

for (const nodes of [undefined, {}, [null], ['']]) test(`malformed explicit replacement cannot clear nodes: ${JSON.stringify(nodes)}`, async () => {
  const id = `invalid-${JSON.stringify(nodes)}`; await seed(id);
  assert.equal((await service.updateAppImage(id, null, null, null, null, null, nodes, true)).updated, false);
  assert.deepEqual((await stored(id)).nodes, ['encrypted-node']);
});

test('concurrent unrelated wallet update and explicit node clearing both survive', async () => {
  await seed('concurrent');
  const responses = await Promise.all([
    service.updateAppImage('concurrent', null, { added: 'new-wallet' }, null, null, null, []),
    service.updateAppImage('concurrent', null, null, null, null, null, [], true),
  ]);
  assert.ok(responses.every(result => result.updated));
  const record = await stored('concurrent');
  assert.deepEqual(record.nodes, []); assert.equal(record.wallets.added, 'new-wallet');
});

// Exercise the actual registered route callback against the real service/DB,
// without loading unrelated production services or opening a network listener.
function routeHandler() {
  const file = 'src/routes/routes.ts';
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), ts.ScriptTarget.Latest, true);
  let registration;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'router.post' &&
        node.arguments[0]?.text === '/updateAppImage') registration = node;
    ts.forEachChild(node, visit);
  }
  visit(source); assert.ok(registration);
  let callback;
  vm.runInNewContext(ts.transpileModule(registration.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText, { bhr: service, router: { post: (_path, handler) => { callback = handler; } } });
  return callback;
}
for (const flag of [true, 'true']) test(`route requires a boolean replacement request: ${typeof flag}`, async () => {
  const id = `route-${typeof flag}`; await seed(id);
  let status, body;
  const response = { status(code) { status = code; return this; }, json(value) { body = value; return this; } };
  await routeHandler()({ body: { appId: id, nodes: [], replaceNodes: flag } }, response);
  assert.equal(status, 200); assert.equal(body.updated, true);
  assert.deepEqual((await stored(id)).nodes, flag === true ? [] : ['encrypted-node']);
});
