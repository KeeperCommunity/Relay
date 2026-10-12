const assert = require('node:assert/strict');

// Override only the loopback server address; fixtures always use their own DB.
exports.testMongoUri = prefix => {
  assert.match(prefix, /^keeper_[a-z_]+_test$/);
  const url = new URL(process.env.BACKUP_TEST_MONGO_URL || 'mongodb://127.0.0.1:27028');
  assert.equal(url.protocol, 'mongodb:', 'Backup tests require disposable MongoDB');
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Backup tests require loopback MongoDB');
  assert.ok(!url.username && !url.password, 'Backup tests must not use hosted credentials');
  url.pathname = `/${prefix}_${process.pid}`;
  url.search = '?directConnection=true&replicaSet=keeperQA';
  return url.toString();
};
