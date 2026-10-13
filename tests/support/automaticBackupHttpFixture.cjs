// Disposable HTTP fixture: exact production route handlers, service code,
// Mongoose schemas and transactions. No hosted bootstrapping or credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ts = require('typescript');
const mongoose = require('mongoose');
const express = require('express');
const root = path.resolve(__dirname, '../..');
let active = false;

function sourceLoader(databaseUrl) {
  const cache = new Map();
  const originalEnvironment = {};
  for (const [key, value] of Object.entries({ DATABASE_URL: databaseUrl,
    LOCAL_DEV: 'true', ENVIRONMENT: 'DEVELOPMENT', BITCOIN_NETWORK: 'TESTNET' })) {
    originalEnvironment[key] = process.env[key];
    process.env[key] = value;
  }
  const load = file => {
    file = path.resolve(root, file);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const nativeRequire = createRequire(file);
    const requireSource = name => {
      // Configuration is provided above, never read a checkout/host .env.
      if (name === 'dotenv') return { ...nativeRequire(name), config: () => ({ parsed: {} }) };
      if (name.startsWith('.')) {
        const candidate = path.resolve(path.dirname(file), name);
        const source = [candidate, `${candidate}.ts`, path.join(candidate, 'index.ts')]
          .find(value => value.endsWith('.ts') && fs.existsSync(value));
        if (source) return load(source);
      }
      return nativeRequire(name);
    };
    const javascript = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    }).outputText;
    const wrapper = vm.runInThisContext(`(function(module,exports,require,__filename,__dirname){${javascript}\n})`, { filename: file });
    wrapper(module, module.exports, requireSource, file, path.dirname(file));
    return module.exports;
  };
  return { load, restoreEnvironment() {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  } };
}

function registerProductionRoutes(router, dependencies) {
  const filename = path.join(root, 'src/routes/routes.ts');
  const text = fs.readFileSync(filename, 'utf8');
  const tree = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const selected = [];
  const required = new Set(['/getBackupSnapshot', '/revisionedBackupMutation']);
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'sendBackupMutationError') selected.push(node.getText(tree));
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'router.post' && required.has(node.arguments[0]?.text)) {
      required.delete(node.arguments[0].text);
      selected.push(`${node.getText(tree)};`);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.equal(required.size, 0, 'Missing production backup route');
  const javascript = ts.transpileModule(selected.join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const names = Object.keys(dependencies);
  vm.runInThisContext(`(function(router,${names.join(',')}){${javascript}\n})`, { filename })
    (router, ...names.map(name => dependencies[name]));
}

async function createFixture(options = {}) {
  assert.equal(active, false, 'Use one fixture per process and close it before another');
  const target = new URL(options.mongoUri || process.env.BACKUP_TEST_MONGO_URL || 'mongodb://127.0.0.1:27058');
  assert.equal(target.protocol, 'mongodb:');
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname), 'Fixture Mongo must be loopback');
  assert.ok(!target.username && !target.password, 'Fixture never accepts credentials');
  const database = `keeper_auto_http_test_${process.pid}_${Date.now()}`;
  target.pathname = `/${database}`;
  target.search = '?directConnection=true&replicaSet=keeperQA';
  active = true;
  const loader = sourceLoader(target.toString());
  let server;
  try {
    const db = loader.load('src/db.ts').default;
    const service = loader.load('src/services/backupSnapshot.ts');
    const bhr = loader.load('src/services/bhr.ts');
    await mongoose.connection.asPromise();
    const models = [db.getAppImageModel(), db.getAppVaultImageModel(),
      db.getVaultImageModel(), db.getLabelModel(), db.getVaultMapModel(), db.getAppModel()];
    await Promise.all(models.map(model => model.init()));
    const trace = [];
    const faults = [];
    const replyTimers = new Set();
    const router = express.Router();
    router.use((req, res, next) => {
      const entry = { path: req.path, operation: req.body?.operation,
        appId: req.body?.appId, routeInvoked: false, committed: false };
      trace.push(entry);
      const index = faults.findIndex(fault => {
        const target = fault.path || (['before-snapshot-reply', 'malformed-metadata'].includes(fault.mode)
          ? '/getBackupSnapshot' : '/revisionedBackupMutation');
        return target === req.path && (!fault.operation || fault.operation === entry.operation)
          && (!fault.appId || fault.appId === entry.appId);
      });
      let fault;
      if (index >= 0) {
        if (faults[index].after > 0) faults[index].after -= 1;
        else fault = faults.splice(index, 1)[0];
      }
      if (req.path === '/getBackupSnapshot') {
        entry.routeInvoked = true;
        if (fault?.mode === 'before-snapshot-reply' || fault?.mode === 'malformed-metadata') {
          const originalJson = res.json.bind(res);
          res.json = body => {
            Promise.resolve().then(() => fault.beforeReply?.({ body, db, service, bhr }))
              .then(() => originalJson(fault.mode === 'malformed-metadata'
                ? { ...body, appImage: { ...body.appImage,
                  ...(fault.metadata || { publicId: 'synthetic-metadata-mismatch' }) } }
                : body)).catch(next);
            return res;
          };
        }
        return next();
      }
      if (req.path !== '/revisionedBackupMutation') { entry.routeInvoked = true; return next(); }
      if (fault?.mode === '404') { entry.status = 404; return res.status(404).json({ error: 'NOT_FOUND' }); }
      const originalJson = res.json.bind(res);
      res.json = body => {
        entry.status = res.statusCode;
        entry.response = body;
        entry.committed = res.statusCode === 200 && body.updated === true;
        if (entry.committed && fault?.mode === 'malformed') return originalJson({ updated: true,
          preconditionApplied: true, newRevision: 'invalid' });
        if (entry.committed && fault?.mode === 'equal-old-ack') return originalJson({ updated: true,
          preconditionApplied: true, newRevision: req.body.expectedRevision });
        if (entry.committed && fault?.mode === 'lost-reply') { req.socket.destroy(); return res; }
        if (entry.committed && fault?.mode === 'delay-reply') {
          const timer = setTimeout(() => {
            replyTimers.delete(timer); originalJson(body);
          }, fault.delayMs || 1000);
          replyTimers.add(timer); return res;
        }
        return originalJson(body);
      };
      const start = async () => {
        if (fault?.beforeMutation) await fault.beforeMutation({ db, service, bhr, body: req.body });
        if (fault?.mode === '409') {
          // A genuine independent transactional writer invalidates the supplied
          // revision. The request then reaches the actual CAS and conflicts.
          await service.withBackupMutation(req.body.appId, async session => {
            await db.getAppImageModel().updateOne({ appId: req.body.appId },
              { $set: { version: 'synthetic-peer-write' } }, { session });
            return { updated: true };
          }, req.body.expectedRevision, true);
        }
        entry.routeInvoked = true;
        next();
      };
      start().catch(next);
    });
    registerProductionRoutes(router, { bhr, ...service });
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use(router);
    app.use((_error, _req, res, _next) => res.status(503).json({ updated: false, error: 'FIXTURE_FAILED' }));
    server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    const url = `http://127.0.0.1:${server.address().port}/`;
    const post = async (endpoint, body, expectedStatus = 200) => {
      const response = await fetch(new URL(endpoint, url), { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json();
      if (expectedStatus !== undefined) assert.equal(response.status, expectedStatus,
        `Expected ${expectedStatus}, got ${response.status} on ${endpoint}: ${JSON.stringify(data)}`);
      return { status: response.status, data };
    };
    const snapshot = async appId => (await post('getBackupSnapshot', { appId })).data;
    return {
      url, database, trace, db, service, bhr, post, snapshot,
      armFault(fault) {
        assert.ok(['404', '409', 'malformed', 'equal-old-ack', 'lost-reply', 'delay-reply',
          'before-snapshot-reply', 'malformed-metadata', undefined].includes(fault.mode));
        faults.push(fault);
      },
      clearTrace() { trace.length = 0; },
      async reset() { faults.length = 0; trace.length = 0; await Promise.all(models.map(model => model.deleteMany({}))); },
      async seed(input) {
        const image = input.appImage || input;
        const appId = image.appId;
        const current = await snapshot(appId);
        const vaultObject = input.vaultObject || Object.fromEntries((input.allVaultImages || []).map(vault =>
          [vault.vaultId, { ...vault, signersData: vault.signersData || [] }]));
        const labels = (input.labels || []).map(label => ({ id: label.id,
          content: label.content ?? label.encryptedLabel }));
        const repair = { appId, publicId: image.publicId || `public-${appId}`,
          version: image.version || '2.6.4', subscription: image.subscription,
          expectedRevision: current.revision,
          walletObject: input.walletObject || image.wallets || {},
          signersObject: input.signersObject || image.signers || {},
          vaultObject, nodes: input.nodes || image.nodes || [], labels,
          operation: 'repairAppBackup', replaceCurrentState: true };
        await post('revisionedBackupMutation', repair);
        return snapshot(appId);
      },
      async close() {
        for (const timer of replyTimers) clearTimeout(timer);
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        assert.equal(mongoose.connection.name, database, 'Refusing non-fixture cleanup');
        await mongoose.connection.dropDatabase();
        await mongoose.disconnect();
        for (const name of mongoose.modelNames()) mongoose.deleteModel(name);
        loader.restoreEnvironment(); active = false;
      },
    };
  } catch (error) {
    if (server) server.close();
    await mongoose.disconnect(); loader.restoreEnvironment(); active = false;
    throw error;
  }
}

module.exports = { createFixture };
