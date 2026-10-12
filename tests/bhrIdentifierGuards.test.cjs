const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const mongoose = require("mongoose");

// Never load .env or production config. Seed and drop only this process's
// database on the disposable keeperQA replica set reached through loopback.
const database = `keeper_identifier_guard_test_${process.pid}`;
const uri = require('./disposableMongo.cjs').testMongoUri('keeper_identifier_guard_test');

function load(file, mocks) {
  const module = { exports: {} };
  const code = ts.transpileModule(
    fs.readFileSync(path.join(__dirname, "..", file), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    },
  ).outputText;
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    global,
    console,
    require: (name) => (name in mocks ? mocks[name] : require(name)),
  });
  return module.exports;
}

const db = load("src/db.ts", {
  "./config": { DATABASE: uri },
  "./interface": { NotificationType: { RELEASE_MESSAGE: "RELEASE_MESSAGE" } },
}).default;
const serviceMocks = {
  "./backupSnapshot": {},
  "../db": db,
  "../interface": {},
  "./app": {},
  "../utils/plans": {},
};
const bhr = load("src/services/bhr.ts", serviceMocks);
let databaseAccesses = 0;
const rejectDatabaseAccess = () => {
  databaseAccesses++;
  throw Error("Invalid identifier reached database");
};
const guards = load("src/services/bhr.ts", {
  ...serviceMocks,
  "../db": {
    getVaultMapModel: rejectDatabaseAccess,
    getVaultImageModel: rejectDatabaseAccess,
  },
});
const plain = (value) => JSON.parse(JSON.stringify(value));
let fixtureDatabaseVerified = false;

before(async () => {
  await new Promise((resolve, reject) => {
    if (mongoose.connection.readyState === 1) return resolve();
    mongoose.connection.once("open", resolve);
    mongoose.connection.once("error", reject);
  });
  assert.equal(mongoose.connection.name, database);
  assert.equal(
    (await mongoose.connection.db.admin().command({ hello: 1 })).setName,
    "keeperQA",
  );
  fixtureDatabaseVerified = true;
  const vault = db.getVaultImageModel();
  const map = db.getVaultMapModel();
  await Promise.all([vault.init(), map.init()]);
  await vault.create([
    {
      vaultId: "fixture-active-vault",
      appId: "fixture-active-account",
      vaultShellId: "fixture-active-shell",
      vault: "fixture-active-encrypted-image",
      isArchived: false,
      signerIds: ["fixture-active-signer"],
    },
    {
      vaultId: "fixture-archived-vault",
      appId: "fixture-archived-account",
      vaultShellId: "fixture-archived-shell",
      vault: "fixture-archived-encrypted-image",
      isArchived: true,
      signerIds: ["fixture-archived-signer"],
    },
  ]);
  await map.create([
    {
      signerId: "fixture-active-signer",
      xfpHash: "fixture-active-hash",
      vaultId: "fixture-active-vault",
    },
    {
      signerId: "fixture-archived-signer",
      xfpHash: "fixture-archived-hash",
      vaultId: "fixture-archived-vault",
    },
  ]);
});

after(async () => {
  if (fixtureDatabaseVerified && mongoose.connection.name === database)
    await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("operator-object lookups cannot return seeded account metadata or images", async () => {
  const operator = { $ne: "" };
  assert.deepEqual(plain(await bhr.getVaultMetaData(operator)), {
    error: "No Vault for this signer Id",
  });
  assert.equal(await bhr.getSignerIdInfo(operator), false);
  assert.equal(await bhr.getVaultImage(operator), undefined);
  assert.deepEqual(plain(await bhr.vaultCheck(operator)), { isVault: false });
  assert.deepEqual(
    plain(await bhr.getVaultMetaData("fixture-active-hash", operator)),
    { error: "No Vault for this signer Id" },
  );
});

test("invalid identifiers are rejected before obtaining a database model", async () => {
  const invalid = [
    { $ne: "" },
    { $regex: ".*" },
    { $in: ["fixture-active-hash"] },
    {},
    [],
    ["fixture-active-hash"],
    true,
    false,
    7,
    null,
    undefined,
    "",
    "   ",
  ];
  for (const value of invalid) {
    assert.deepEqual(plain(await guards.getVaultMetaData(value)), {
      error: "No Vault for this signer Id",
    });
    assert.equal(await guards.getSignerIdInfo(value), false);
    assert.equal(await guards.getVaultImage(value), undefined);
    assert.deepEqual(plain(await guards.vaultCheck(value)), { isVault: false });
    if (value !== undefined)
      assert.deepEqual(
        plain(await guards.getVaultMetaData("fixture-active-hash", value)),
        { error: "No Vault for this signer Id" },
      );
  }
  assert.equal(databaseAccesses, 0);
});

test("valid string lookups preserve metadata, image and existence contracts", async () => {
  const expected = {
    appId: "fixture-active-account",
    vaultShellId: "fixture-active-shell",
  };
  assert.deepEqual(
    plain(await bhr.getVaultMetaData("fixture-active-hash")),
    expected,
  );
  assert.deepEqual(
    plain(
      await bhr.getVaultMetaData(
        "fixture-active-hash",
        "fixture-active-signer",
      ),
    ),
    expected,
  );
  assert.equal(await bhr.getSignerIdInfo("fixture-active-signer"), true);
  assert.equal(
    (await bhr.getVaultImage("fixture-active-vault")).vault,
    "fixture-active-encrypted-image",
  );
  assert.deepEqual(plain(await bhr.vaultCheck("fixture-active-vault")), {
    isVault: true,
  });
  assert.deepEqual(plain(await bhr.vaultCheck("fixture-archived-vault")), {
    isVault: false,
  });
});

test("unmatched strings retain existing not-found responses", async () => {
  assert.deepEqual(plain(await bhr.getVaultMetaData("fixture-unknown-hash")), {
    error: "No Vault for this signer Id",
  });
  assert.equal(await bhr.getSignerIdInfo("fixture-unknown-signer"), false);
  assert.equal(await bhr.getVaultImage("fixture-unknown-vault"), undefined);
  assert.deepEqual(plain(await bhr.vaultCheck("fixture-unknown-vault")), {
    isVault: false,
  });
});
