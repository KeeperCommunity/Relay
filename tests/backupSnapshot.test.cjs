const {test,before,after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ts = require('typescript');
const mongoose = require('mongoose');
const crypto = require('node:crypto');
// Deliberately ignore .env and production integration config. Only disposable
// loopback Mongo is accepted, and only this uniquely named test DB is dropped.
const database = `keeper_recovery_test_${process.pid}`;
const uri = require('./disposableMongo.cjs').testMongoUri('keeper_recovery_test');
function load(file,mocks={}) {
 const module={exports:{}};
 const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
 vm.runInNewContext(code,{module,exports:module.exports,global,console,require:n=>n in mocks?mocks[n]:require(n)});
 return module.exports;
}
const db=load('src/db.ts',{'./config':{DATABASE:uri},'./interface':{NotificationType:{RELEASE_MESSAGE:'RELEASE_MESSAGE'}}}).default;
const legacy=load('src/services/bhr.ts',{'./backupSnapshot':load('src/services/backupSnapshot.ts',{'../db':db}),'../db':db,'../interface':{},'./app':{getAppSubscriptionDetails:async()=>({level:0,isCancelled:false})},'../utils/plans':{getPlans:()=>[{level:0,name:'synthetic-plan'}]}});
const service=load('src/services/backupSnapshot.ts',{'../db':db});
let app,vault,appVault,label,map;
before(async()=>{
 await new Promise((resolve,reject)=>{if(mongoose.connection.readyState===1)return resolve();mongoose.connection.once('open',resolve);mongoose.connection.once('error',reject);});
 [app,vault,label,map]=[db.getAppImageModel(),db.getVaultImageModel(),db.getLabelModel(),db.getVaultMapModel()];
 appVault=db.getAppVaultImageModel();
 await Promise.all([app.init(),vault.init(),appVault.init(),label.init(),map.init()]);
});
after(async()=>{await mongoose.connection.dropDatabase();await mongoose.disconnect();});
async function payload(id){const snap=await service.getBackupSnapshot(id);return {appId:id,publicId:`public-${id}`,version:'2.5.16',expectedRevision:snap.revision,walletObject:{w:'encrypted-wallet'},signersObject:{},vaultObject:{},nodes:[],labels:[]};}
test('absent app repair stores all records atomically and returns a new revision',async()=>{
 const p=await payload('new'); await service.repairAppBackup(p);
 const s=await service.getBackupSnapshot('new');assert.equal(s.appImage.wallets.w,'encrypted-wallet');assert.notEqual(s.revision,p.expectedRevision);
});
test('stale revision rejects repair and preserves another device wallet',async()=>{
 const p=await payload('stale');await service.repairAppBackup(p);
 p.expectedRevision=(await service.getBackupSnapshot('stale')).revision;
 await app.updateOne({appId:'stale'},{$set:{'wallets.other':'other-device'}});
 await assert.rejects(service.repairAppBackup(p),service.BackupConflict);
 assert.equal((await app.findOne({appId:'stale'}).lean()).wallets.other,'other-device');
});
test('two repairs from one revision cannot both commit',async()=>{
 const p=await payload('race');await service.repairAppBackup(p);p.expectedRevision=(await service.getBackupSnapshot('race')).revision;
 const outcomes=await Promise.allSettled([service.repairAppBackup({...p,walletObject:{w:'device-A'}}),service.repairAppBackup({...p,walletObject:{w:'device-B'}})]);
 assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);assert.equal(outcomes.filter(o=>o.status==='rejected').length,1);
});
test('same label id updates content without dropping the label',async()=>{
 const p=await payload('labels');p.labels=[{id:'label-1',content:'old-encrypted'}];await service.repairAppBackup(p);
 p.expectedRevision=(await service.getBackupSnapshot('labels')).revision;p.labels[0].content='new-encrypted';await service.repairAppBackup(p);
 const s=await service.getBackupSnapshot('labels');assert.equal(s.labels[0].content,'new-encrypted');assert.deepEqual(s.appImage.labels,['label-1']);
});
test('repair cannot silently delete server-only records even with current revision',async()=>{
 const p=await payload('omission');await service.repairAppBackup(p);p.expectedRevision=(await service.getBackupSnapshot('omission')).revision;p.walletObject={};
 await assert.rejects(service.repairAppBackup(p),service.BackupConflict);assert.equal((await service.getBackupSnapshot('omission')).appImage.wallets.w,'encrypted-wallet');
});
test('explicit current-state repair removes absent records and orphaned vault and label data',async()=>{
 const p=await payload('current-state');
 p.signersObject={key:'encrypted-key'};
 p.vaultObject={old:{vaultId:'old',vault:'encrypted-vault',isArchived:true,signersData:[{signerId:'key',xfpHash:'hash'}]}};
 p.labels=[{id:'old-label',content:'encrypted-label'}];
 await service.repairAppBackup(p);
 const before=await service.getBackupSnapshot(p.appId);
 await service.repairAppBackup({...p,expectedRevision:before.revision,replaceCurrentState:true,
   walletObject:{},signersObject:{},vaultObject:{},labels:[]});
 const after=await service.getBackupSnapshot(p.appId);
 assert.deepEqual(after.appImage.wallets,{});
 assert.deepEqual(after.appImage.signers,{});
 assert.deepEqual(after.appImage.vaults,[]);
 assert.deepEqual(after.appImage.labels,[]);
 assert.equal(await vault.countDocuments({vaultId:'old'}),0);
 assert.equal(await label.countDocuments({id:'old-label'}),0);
 assert.equal(await map.countDocuments({vaultId:'old'}),0);
});
test('stale current-state repair cannot remove a newer record',async()=>{
 const p=await payload('current-state-race');await service.repairAppBackup(p);
 const oldRevision=(await service.getBackupSnapshot(p.appId)).revision;
 await app.updateOne({appId:p.appId},{$set:{'wallets.newer':'encrypted-newer'}});
 await assert.rejects(service.repairAppBackup({...p,expectedRevision:oldRevision,replaceCurrentState:true,walletObject:{}}),service.BackupConflict);
 assert.equal((await service.getBackupSnapshot(p.appId)).appImage.wallets.newer,'encrypted-newer');
});
test('explicit backup deletion leaves no recoverable records or orphaned vault data',async()=>{
 const p=await payload('delete-choice');
 p.signersObject={key:'encrypted-key'};
 p.vaultObject={vault:{vaultId:'vault',vault:'encrypted-vault',isArchived:false,signersData:[{signerId:'key',xfpHash:'hash'}]}};
 p.labels=[{id:'delete-label',content:'encrypted-label'}];
 await service.repairAppBackup(p);
 const result=await legacy.deleteBackup(p.appId);
 assert.equal(result.updated,true);
 assert.equal(result.error,'');
 const remaining=await service.getBackupSnapshot(p.appId);
 assert.deepEqual(remaining.appImage.wallets,{});
 assert.deepEqual(remaining.appImage.signers,{});
 assert.deepEqual(remaining.appImage.vaults,[]);
 assert.deepEqual(remaining.appImage.labels,[]);
 assert.equal(await vault.countDocuments({vaultId:'vault'}),0);
 assert.equal(await label.countDocuments({id:'delete-label'}),0);
 assert.equal(await map.countDocuments({vaultId:'vault'}),0);
});
test('failed explicit deletion rolls back earlier vault removals',async()=>{
 const p=await payload('delete-rollback');
 p.vaultObject={'rollback-vault':{vaultId:'rollback-vault',vault:'encrypted-vault',isArchived:false,signersData:[]}};
 p.labels=[{id:'rollback-label',content:'encrypted-label'}];
 await service.repairAppBackup(p);
 const original=label.deleteOne;
 label.deleteOne=()=>({session:async()=>{throw Error('disposable deletion failure');}});
 try { await assert.rejects(legacy.deleteBackup(p.appId)); }
 finally { label.deleteOne=original; }
 const remaining=await service.getBackupSnapshot(p.appId);
 assert.equal(remaining.appImage.wallets.w,'encrypted-wallet');
 assert.deepEqual(remaining.appImage.vaults,['rollback-vault']);
 assert.deepEqual(remaining.appImage.labels,['rollback-label']);
 assert.equal(await vault.countDocuments({vaultId:'rollback-vault'}),1);
 assert.equal(await label.countDocuments({id:'rollback-label'}),1);
});
test('failure after earlier writes rolls the entire transaction back',async()=>{
 const owner=await payload('owner');owner.labels=[{id:'rollback-owned-label',content:'owned'}];await service.repairAppBackup(owner);
 const p=await payload('rollback');p.vaultObject={v1:{vaultId:'v1',vault:'first-write',isArchived:false,signersData:[]}};p.labels=[{id:'rollback-owned-label',content:'wrong-owner'}];
 await assert.rejects(service.repairAppBackup(p),service.BackupConflict);assert.equal(await vault.countDocuments({vaultId:'v1'}),0);assert.equal(await appVault.countDocuments({appId:p.appId}),0);assert.equal(await app.countDocuments({appId:'rollback'}),0);
});
test('archived metadata survives and active signer map survives archive ordering',async()=>{
 const p=await payload('archive');const signersData=[{signerId:'fixture-signer',xfpHash:'fixture-hash'}];
 p.vaultObject={active:{vaultId:'active',vault:'active-image',isArchived:false,signersData},archived:{vaultId:'archived',vault:'archived-image',isArchived:true,signersData}};
 await service.repairAppBackup(p);assert.equal((await vault.findOne({vaultId:'archived'}).lean()).isArchived,true);assert.equal((await map.findOne({signerId:'fixture-signer'}).lean()).vaultId,'active');
});
test('incomplete referenced records fail closed',async()=>{
 const p=await payload('incomplete');await service.repairAppBackup(p);await app.updateOne({appId:'incomplete'},{$set:{labels:['missing-record']}});
 await assert.rejects(service.getBackupSnapshot('incomplete'),/Incomplete backup/);
});
test('malformed encrypted payload cannot create records',async()=>{
 const p=await payload('invalid');p.nodes=[{}];await assert.rejects(service.repairAppBackup(p),/Invalid encrypted node/);assert.equal(await app.countDocuments({appId:'invalid'}),0);
});

test('version-only incremental update succeeds without nodes and preserves records',async()=>{
 const p=await payload('version');await service.repairAppBackup(p);
 assert.equal((await legacy.updateAppImage('version',undefined,undefined,undefined,'2.5.17')).updated,true);
 const s=await service.getBackupSnapshot('version');assert.equal(s.appImage.version,'2.5.17');assert.equal(s.appImage.wallets.w,'encrypted-wallet');
});
test('concurrent incremental updates preserve both wallets',async()=>{
 const p=await payload('increments');await service.repairAppBackup(p);
 const results=await Promise.all([legacy.updateAppImage('increments',null,{a:'device-a'}),legacy.updateAppImage('increments',null,{b:'device-b'})]);
 assert.ok(results.every(r=>r.updated));const s=await service.getBackupSnapshot('increments');assert.deepEqual(s.appImage.wallets,{w:'encrypted-wallet',a:'device-a',b:'device-b'});
});

test('legacy first and repeat full backups work until revisioned repair',async()=>{
 const p=await payload('legacy-full');delete p.expectedRevision;
 assert.equal((await legacy.backupAllSignersAndVaults(p)).updated,true);
 p.walletObject.extra='later-wallet';
 assert.equal((await legacy.backupAllSignersAndVaults(p)).updated,true);
 assert.equal(!!(await service.getBackupSnapshot(p.appId)).appImage.backupRevisionRequired,false);
});
test('legacy full backup cannot overwrite a repaired backup',async()=>{
 const p=await payload('protected');await service.repairAppBackup(p);
 await assert.rejects(legacy.backupAllSignersAndVaults({...p,walletObject:{w:'stale'}}),/Update the app/);
 const s=await service.getBackupSnapshot(p.appId);assert.equal(s.appImage.wallets.w,'encrypted-wallet');assert.equal(s.appImage.backupRevisionRequired,true);
});
test('legacy omissions cannot delete server-only keys, wallets, vaults or labels',async()=>{
 for(const kind of ['walletObject','signersObject','vaultObject','labels']){
  const p=await payload(`legacy-omission-${kind}`);
  p.signersObject={k:'key-image'};p.vaultObject[`v-${kind}`]={vaultId:`v-${kind}`,vault:'vault-image',signersData:[]};p.labels=[{id:`l-${kind}`,content:'label-image'}];
  await legacy.backupAllSignersAndVaults(p);const before=await service.getBackupSnapshot(p.appId);
  await assert.rejects(legacy.backupAllSignersAndVaults({...p,[kind]:kind==='labels'?[]:{}}),/Backup changed/);
  assert.equal((await service.getBackupSnapshot(p.appId)).revision,before.revision);
 }
});
test('legacy writer preserves archive status absent from old payloads',async()=>{
 const p=await payload('legacy-archive');p.vaultObject['legacy-archived']={vault:'image',signersData:[],vaultShellId:'fixture-shell'};
 await legacy.backupAllSignersAndVaults(p);await legacy.archiveVault('legacy-archived');
 await legacy.backupAllSignersAndVaults(p);const result=await vault.findOne({vaultId:'legacy-archived'}).lean();assert.equal(result.isArchived,true);assert.equal(result.vaultShellId,'fixture-shell');
});
test('legacy versus repair race never overwrites a committed repair',async()=>{
 for(let i=0;i<10;i++){
  const p=await payload(`legacy-race-${i}`);await legacy.backupAllSignersAndVaults(p);
  p.expectedRevision=(await service.getBackupSnapshot(p.appId)).revision;
  const [oldResult,newResult]=await Promise.allSettled([
   legacy.backupAllSignersAndVaults({...p,walletObject:{w:'old-writer'}}),
   service.repairAppBackup({...p,walletObject:{w:'repaired',extra:'keep-me'}}),
  ]);
  const s=await service.getBackupSnapshot(p.appId);
  if(newResult.status==='fulfilled'){
   assert.equal(s.appImage.wallets.w,'repaired');assert.equal(s.appImage.wallets.extra,'keep-me');assert.equal(s.appImage.backupRevisionRequired,true);
  }else{
   assert.equal(oldResult.status,'fulfilled');assert.match(newResult.reason.message,/Backup changed/);
   assert.equal(s.appImage.wallets.w,'old-writer');
  }
 }
});
test('repair with unchanged ciphertext still protects against an overlapping legacy replacement',async()=>{
 for(let i=0;i<10;i++){
  const p=await payload(`marker-race-${i}`);await legacy.backupAllSignersAndVaults(p);
  p.expectedRevision=(await service.getBackupSnapshot(p.appId)).revision;
  const [repair]=await Promise.allSettled([
   service.repairAppBackup(p),
   legacy.backupAllSignersAndVaults({...p,walletObject:{w:'stale-writer'}}),
  ]);
  const s=await service.getBackupSnapshot(p.appId);
  if(repair.status==='fulfilled'){
   assert.equal(s.appImage.wallets.w,'encrypted-wallet');assert.equal(s.appImage.backupRevisionRequired,true);
  }else assert.match(repair.reason.message,/Backup changed/);
 }
});
test('label ownership collision fails without altering either backup',async()=>{
 const owner=await payload('label-owner');owner.labels=[{id:'owned-label',content:'keep-this'}];await service.repairAppBackup(owner);
 const other=await payload('label-other');other.labels=[{id:'owned-label',content:'wrong-account'}];
 await assert.rejects(service.repairAppBackup(other),/Backup changed/);
 assert.equal((await service.getBackupSnapshot(owner.appId)).labels[0].content,'keep-this');
 assert.equal((await service.getBackupSnapshot(other.appId)).exists,false);
});

test('incremental deletion acknowledges commit and leaves valid empty wallet/key maps',async()=>{
 const p=await payload('entity-delete-empty');p.signersObject={key:'encrypted-key'};
 await service.repairAppBackup(p);
 const result=await legacy.deleteAppImageEntity(p.appId,['w'],['key']);
 assert.equal(result.updated,true);assert.equal(result.error,'');
 const stored=await app.findOne({appId:p.appId}).lean();
 assert.deepEqual(stored.wallets,{});assert.deepEqual(stored.signers,{});
 assert.equal(stored.backupRevisionRequired,true);
});

test('incremental deletion preserves missing-account and omitted-ID behavior',async()=>{
 const missing=await legacy.deleteAppImageEntity('entity-delete-missing',undefined,undefined);
 assert.equal(missing.updated,false);assert.equal(missing.error,'No app image');
 const p=await payload('entity-delete-noop');await service.repairAppBackup(p);
 const before=(await service.getBackupSnapshot(p.appId)).revision;
 for(const ids of [undefined,null,[],['absent-id']]){
  assert.equal((await legacy.deleteAppImageEntity(p.appId,ids,ids)).updated,true);
  assert.equal((await service.getBackupSnapshot(p.appId)).revision,before);
 }
});

test('unsafe incremental deletion IDs cannot modify a backup',async()=>{
 const p=await payload('entity-delete-invalid');await service.repairAppBackup(p);
 const before=(await service.getBackupSnapshot(p.appId)).revision;
 for(const ids of [['w.nested'],['$wallet'],['__proto__'],[null],{},['']]){
  assert.equal((await legacy.deleteAppImageEntity(p.appId,ids,[])).updated,false);
  assert.equal((await service.getBackupSnapshot(p.appId)).revision,before);
 }
});

test('incremental deletion write failure reports failure and rolls back both maps',async()=>{
 const p=await payload('entity-delete-failed');p.signersObject={key:'encrypted-key'};
 await service.repairAppBackup(p);
 const before=(await service.getBackupSnapshot(p.appId)).revision;
 const original=app.updateOne;
 app.updateOne=async function(filter,changes,options){
  const result=await original.call(this,filter,changes,options);
  if(changes.$unset) throw Error('disposable deletion acknowledgement failure');
  return result;
 };
 let result;
 try { result=await legacy.deleteAppImageEntity(p.appId,['w'],['key']); }
 finally { app.updateOne=original; }
 assert.equal(result.updated,false);assert.equal(result.error,'Backup deletion failed');
 assert.equal((await service.getBackupSnapshot(p.appId)).revision,before);
});

function delayedEntityDeletion(){
 const original=app.updateOne;
 let release,announce,paused=false,attempts=0;
 const gate=new Promise(resolve=>{release=resolve;});
 const started=new Promise(resolve=>{announce=resolve;});
 app.updateOne=async function(filter,changes,options){
  if(changes.$unset){
   attempts++;
   if(!paused){paused=true;announce();await gate;}
  }
  return original.call(this,filter,changes,options);
 };
 return {started,release,attempts:()=>attempts,restore:()=>{app.updateOne=original;release();}};
}

test('incremental deletion cannot report success before its write completes',async()=>{
 const p=await payload('entity-delete-ack');await service.repairAppBackup(p);
 const pause=delayedEntityDeletion();let complete=false;
 const deletion=legacy.deleteAppImageEntity(p.appId,['w'],[]).then(result=>{complete=true;return result;});
 try {
  await Promise.race([pause.started,deletion.then(()=>{throw Error('deletion returned before its write');})]);
  assert.equal(complete,false);
  assert.equal((await app.findOne({appId:p.appId}).lean()).wallets.w,'encrypted-wallet');
  pause.release();assert.equal((await deletion).updated,true);
  assert.deepEqual((await app.findOne({appId:p.appId}).lean()).wallets,{});
 } finally {pause.restore();await deletion;}
});

test('delayed incremental deletion preserves a newer repair instead of replacing its map',async()=>{
 const p=await payload('entity-delete-repair-race');
 p.walletObject={w:'older-retained',remove:'delete-this','server-only':'old-backup-only'};
 p.signersObject={old:'older-key',remove:'delete-key'};
 await service.repairAppBackup(p);
 const revision=(await service.getBackupSnapshot(p.appId)).revision;
 const pause=delayedEntityDeletion();
 const deletion=legacy.deleteAppImageEntity(p.appId,['remove'],['remove']);
 try {
  await Promise.race([pause.started,deletion.then(()=>{throw Error('deletion returned before its write');})]);
  await service.repairAppBackup({...p,expectedRevision:revision,replaceCurrentState:true,
   walletObject:{w:'repaired-retained',remove:'delete-this',newer:'new-wallet'},
   signersObject:{old:'repaired-key',remove:'delete-key',newer:'new-key'}});
  pause.release();assert.equal((await deletion).updated,true);
  const stored=await app.findOne({appId:p.appId}).lean();
  assert.deepEqual(stored.wallets,{w:'repaired-retained',newer:'new-wallet'});
  assert.deepEqual(stored.signers,{old:'repaired-key',newer:'new-key'});
  assert.equal(stored.backupRevisionRequired,true);
  assert.ok(pause.attempts()>1,'the real Mongo conflict retried the deletion transaction');
 } finally {pause.restore();await deletion;}
});

function vaultUpdateRouteHandler(){
 const file='src/routes/routes.ts';
 const source=ts.createSourceFile(file,fs.readFileSync(path.join(__dirname,'..',file),'utf8'),ts.ScriptTarget.Latest,true);
 let registration,callback;
 function visit(node){
  if(ts.isCallExpression(node)&&node.expression.getText(source)==='router.post'&&node.arguments[0]?.text==='/updateVaultImage') registration=node;
  ts.forEachChild(node,visit);
 }
 visit(source);assert.ok(registration);
 vm.runInNewContext(ts.transpileModule(registration.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText,
  {bhr:legacy,console,router:{post:(_path,handler)=>{callback=handler;}}});
 return callback;
}

test('existing vault update waits for persistence and returns exactly one response',async()=>{
 const p=await payload('vault-route-update');
 p.vaultObject={'route-vault':{vaultId:'route-vault',vault:'old-image',isArchived:false,signersData:[]}};
 await service.repairAppBackup(p);
 const original=legacy.addVaultImage;let addCalls=0,responses=0,status,body;
 legacy.addVaultImage=async()=>{addCalls++;return {updated:true};};
 const response={status(code){status=code;return this;},json(value){responses++;body=value;if(responses>1)throw Error('double response');return this;}};
 try {await vaultUpdateRouteHandler()({body:{isUpdate:true,vaultId:'route-vault',vault:'new-image'}},response);}
 finally {legacy.addVaultImage=original;}
 assert.equal(status,200);assert.equal(body.updated,true);assert.equal(responses,1);assert.equal(addCalls,0);
 assert.equal((await vault.findOne({vaultId:'route-vault'}).lean()).vault,'new-image');
});

test('missing vault update fails once without falling through to vault creation',async()=>{
 const original=legacy.addVaultImage;let addCalls=0,responses=0,status,body;
 legacy.addVaultImage=async()=>{addCalls++;return {updated:true};};
 const response={status(code){status=code;return this;},json(value){responses++;body=value;return this;}};
 try {await vaultUpdateRouteHandler()({body:{isUpdate:true,vaultId:'missing-route-vault',vault:'new-image'}},response);}
 finally {legacy.addVaultImage=original;}
 assert.equal(status,503);assert.equal(body.updated,false);assert.equal(responses,1);assert.equal(addCalls,0);
 assert.equal(await vault.countDocuments({vaultId:'missing-route-vault'}),0);
});

test('vault update persistence failure returns one failure response',async()=>{
 const p=await payload('vault-route-failed');
 p.vaultObject={'failed-route-vault':{vaultId:'failed-route-vault',vault:'keep-image',isArchived:false,signersData:[]}};
 await service.repairAppBackup(p);
 const original=vault.collection.updateOne;let responses=0,status,body;
 vault.collection.updateOne=function(...args){const callback=args[args.length-1];callback(Error('disposable vault write failure'));};
 const response={status(code){status=code;return this;},json(value){responses++;body=value;return this;}};
 try {await vaultUpdateRouteHandler()({body:{isUpdate:true,vaultId:'failed-route-vault',vault:'failed-image'}},response);}
 finally {vault.collection.updateOne=original;}
 assert.equal(status,503);assert.equal(body.updated,false);assert.equal(responses,1);
 assert.equal((await vault.findOne({vaultId:'failed-route-vault'}).lean()).vault,'keep-image');
});

const signerData = id => [{signerId:id,xfpHash:`hash-${id}`}];
const vaultRecord = (id,key,image='encrypted-vault') => ({vaultId:id,vault:image,isArchived:false,signersData:signerData(key)});
function interceptQuery(model,method,predicate,intercept){
 const original=model[method];
 model[method]=function(...args){
  const query=original.apply(this,args),exec=query.exec;
  if(predicate(...args)) query.exec=async function(...execArgs){
   return intercept(()=>exec.apply(this,execArgs));
  };
  return query;
 };
 return ()=>{model[method]=original;};
}
function pauseQuery(model,method,predicate){
 let release,announce,paused=false,attempts=0;
 const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{announce=resolve;});
 const restore=interceptQuery(model,method,predicate,async execute=>{
  attempts++;
  if(!paused){paused=true;announce();await gate;}
  return execute();
 });
 return {started,release,attempts:()=>attempts,restore:()=>{restore();release();}};
}

test('incremental vault creation commits image, membership and maps without duplicate IDs',async()=>{
 const p=await payload('vault-add-atomic');await service.repairAppBackup(p);
 for(let repeat=0;repeat<2;repeat++){
  const result=await legacy.addVaultImage(p.appId,'fixture-shell','new-vault',{m:2,n:3},'fixture-image',signerData('new-vault-key'));
  assert.equal(result.updated,true);
  const stored=await service.getBackupSnapshot(p.appId);
  assert.deepEqual(stored.appImage.vaults,['new-vault']);
  assert.equal(stored.allVaultImages[0].vault,'fixture-image');
  assert.equal((await map.findOne({signerId:'new-vault-key'}).lean()).vaultId,'new-vault');
  assert.equal(stored.appImage.backupRevisionRequired,true);
 }
 const request=await payload(p.appId);
 await assert.rejects(legacy.backupAllSignersAndVaults(request),/Update the app/);
});

test('vault creation cannot acknowledge before the final signer map write commits',async()=>{
 const p=await payload('vault-add-ack');await service.repairAppBackup(p);
 const pause=pauseQuery(map,'updateOne',filter=>filter.signerId==='ack-vault-key');
 const creation=legacy.addVaultImage(p.appId,null,'ack-vault',null,'fixture-image',signerData('ack-vault-key'));
 try {
  await Promise.race([pause.started,creation.then(()=>{throw Error('vault creation returned before its map write');})]);
  assert.deepEqual((await service.getBackupSnapshot(p.appId)).appImage.vaults,[]);
  assert.equal(await vault.countDocuments({vaultId:'ack-vault'}),0);
  pause.release();assert.equal((await creation).updated,true);
  assert.equal((await map.findOne({signerId:'ack-vault-key'}).lean()).vaultId,'ack-vault');
 } finally {pause.restore();await creation;}
});

test('vault creation map failure rolls back image, maps and membership',async()=>{
 const p=await payload('vault-add-failed');await service.repairAppBackup(p);
 const restore=interceptQuery(map,'updateOne',filter=>filter.signerId==='failed-vault-key',async execute=>{
  await execute();throw Error('disposable map acknowledgement failure');
 });
 let result;
 try {result=await legacy.addVaultImage(p.appId,null,'failed-vault',null,'fixture-image',signerData('failed-vault-key'));}
 finally {restore();}
 assert.equal(result.updated,false);
 assert.deepEqual((await service.getBackupSnapshot(p.appId)).appImage.vaults,[]);
 assert.equal(await vault.countDocuments({vaultId:'failed-vault'}),0);
 assert.equal(await map.countDocuments({signerId:'failed-vault-key'}),0);
});

test('delayed vault creation preserves a newer repair membership and removed records',async()=>{
 const p=await payload('vault-add-repair-race');p.vaultObject.old=vaultRecord('old','old-race-key');
 await service.repairAppBackup(p);const revision=(await service.getBackupSnapshot(p.appId)).revision;
 const pause=pauseQuery(app,'updateOne',(_filter,changes)=>changes.$addToSet?.vaults==='delayed-new');
 const creation=legacy.addVaultImage(p.appId,null,'delayed-new',null,'new-image',signerData('delayed-key'));
 try {
  await Promise.race([pause.started,creation.then(()=>{throw Error('creation did not await membership');})]);
  await service.repairAppBackup({...p,expectedRevision:revision,replaceCurrentState:true,
   walletObject:{w:'repaired-wallet',extra:'newer-wallet'},vaultObject:{other:vaultRecord('other','other-race-key')}});
  pause.release();assert.equal((await creation).updated,true);
  const stored=await service.getBackupSnapshot(p.appId);
  assert.deepEqual([...stored.appImage.vaults].sort(),['delayed-new','other']);
  assert.equal(stored.appImage.wallets.extra,'newer-wallet');assert.equal(stored.appImage.wallets.w,'repaired-wallet');
  assert.equal(await vault.countDocuments({vaultId:'old'}),0);
  assert.equal((await map.findOne({signerId:'delayed-key'}).lean()).vaultId,'delayed-new');
  assert.ok(pause.attempts()>1,'membership conflict retried the creation transaction');
 } finally {pause.restore();await creation;}
});

test('legacy archive-and-add route commits both changes and retains the active signer map',async()=>{
 const p=await payload('vault-archive-route');p.vaultObject.previous=vaultRecord('previous','shared-migration-key');
 await service.repairAppBackup(p);let responses=0,status,body;
 const response={status(code){status=code;return this;},json(value){responses++;body=value;return this;}};
 await vaultUpdateRouteHandler()({body:{appID:p.appId,archiveVaultId:'previous',vaultId:'replacement',vault:'replacement-image',signersData:signerData('shared-migration-key')}},response);
 assert.equal(status,200);assert.equal(body.updated,true);assert.equal(responses,1);
 assert.equal((await vault.findOne({vaultId:'previous'}).lean()).isArchived,true);
 assert.equal((await map.findOne({signerId:'shared-migration-key'}).lean()).vaultId,'replacement');
 assert.deepEqual([...((await service.getBackupSnapshot(p.appId)).appImage.vaults)].sort(),['previous','replacement']);
});

test('legacy archive-and-add failure restores the previous archive and map',async()=>{
 const p=await payload('vault-archive-add-failed');p.vaultObject.previous=vaultRecord('archive-failed-previous','archive-failed-key');
 // The record dictionary key is also its vault ID.
 p.vaultObject={'archive-failed-previous':p.vaultObject.previous};
 await service.repairAppBackup(p);
 const restore=interceptQuery(map,'updateOne',filter=>filter.signerId==='archive-failed-key',async execute=>{
  await execute();throw Error('disposable replacement map failure');
 });
 let result;
 try {result=await legacy.addVaultImage(p.appId,null,'failed-replacement',null,'replacement-image',signerData('archive-failed-key'),null,'archive-failed-previous');}
 finally {restore();}
 assert.equal(result.updated,false);
 assert.equal((await vault.findOne({vaultId:'archive-failed-previous'}).lean()).isArchived,false);
 assert.equal((await map.findOne({signerId:'archive-failed-key'}).lean()).vaultId,'archive-failed-previous');
 assert.equal(await vault.countDocuments({vaultId:'failed-replacement'}),0);
});

test('standalone legacy map creation awaits and rolls back the entire map batch',async()=>{
 const p=await payload('vault-map-batch');p.vaultObject['map-batch-vault']=vaultRecord('map-batch-vault','existing-map-key');
 await service.repairAppBackup(p);
 const restore=interceptQuery(map,'updateOne',filter=>filter.signerId==='second-map-key',async execute=>{
  await execute();throw Error('disposable second map failure');
 });
 try {await assert.rejects(legacy.createVaultMap([...signerData('first-map-key'),...signerData('second-map-key')],'map-batch-vault'));}
 finally {restore();}
 assert.equal(await map.countDocuments({signerId:{$in:['first-map-key','second-map-key']}}),0);
 assert.equal((await map.findOne({signerId:'existing-map-key'}).lean()).vaultId,'map-batch-vault');
});

test('standalone archive cannot acknowledge before map removal and rolls back failure',async()=>{
 const p=await payload('vault-archive-ack');p.vaultObject['archive-ack-vault']=vaultRecord('archive-ack-vault','archive-ack-key');
 await service.repairAppBackup(p);
 const pause=pauseQuery(map,'deleteMany',filter=>filter.vaultId==='archive-ack-vault');
 const archiving=legacy.archiveVault('archive-ack-vault');
 try {
  await Promise.race([pause.started,archiving.then(()=>{throw Error('archive acknowledged before map deletion');})]);
  assert.equal((await vault.findOne({vaultId:'archive-ack-vault'}).lean()).isArchived,false);
  pause.release();assert.equal(await archiving,true);
 } finally {pause.restore();await archiving;}
 assert.equal((await vault.findOne({vaultId:'archive-ack-vault'}).lean()).isArchived,true);
 assert.equal(await map.countDocuments({signerId:'archive-ack-key'}),0);
 const second=await payload('vault-archive-failed');second.vaultObject['archive-failed-vault']=vaultRecord('archive-failed-vault','archive-rollback-key');
 await service.repairAppBackup(second);
 const restore=interceptQuery(map,'deleteMany',filter=>filter.vaultId==='archive-failed-vault',async execute=>{
  await execute();throw Error('disposable archive cleanup failure');
 });
 try {assert.equal(await legacy.archiveVault('archive-failed-vault'),false);}
 finally {restore();}
 assert.equal((await vault.findOne({vaultId:'archive-failed-vault'}).lean()).isArchived,false);
 assert.equal(await map.countDocuments({signerId:'archive-rollback-key'}),1);
});

test('vault deletion atomically clears last membership, image and signer lookup',async()=>{
 const p=await payload('vault-delete-atomic');p.vaultObject['delete-atomic-vault']=vaultRecord('delete-atomic-vault','delete-atomic-key');
 await service.repairAppBackup(p);
 assert.equal((await legacy.deleteVaults(p.appId,['delete-atomic-vault'])).updated,true);
 const stored=await service.getBackupSnapshot(p.appId);
 assert.deepEqual(stored.appImage.vaults,[]);assert.deepEqual(stored.allVaultImages,[]);
 assert.equal(await map.countDocuments({signerId:'delete-atomic-key'}),0);
 assert.equal(stored.appImage.backupRevisionRequired,true);
});

test('vault deletion failure rolls back earlier map cleanup and image deletion',async()=>{
 const p=await payload('vault-delete-failed');p.vaultObject['delete-failed-vault']=vaultRecord('delete-failed-vault','delete-failed-key');
 await service.repairAppBackup(p);const before=(await service.getBackupSnapshot(p.appId)).revision;
 const restore=interceptQuery(appVault,'deleteMany',filter=>filter.appId===p.appId,async execute=>{
  await execute();throw Error('disposable vault deletion failure');
 });
 try {assert.equal((await legacy.deleteVaults(p.appId,['delete-failed-vault'])).updated,false);}
 finally {restore();}
 assert.equal((await service.getBackupSnapshot(p.appId)).revision,before);
 assert.equal(await map.countDocuments({signerId:'delete-failed-key'}),1);
});

test('delayed vault deletion preserves newer repaired membership and vault contents',async()=>{
 const p=await payload('vault-delete-repair-race');
 p.vaultObject={remove:vaultRecord('delete-race-remove','delete-race-remove-key'),keep:vaultRecord('delete-race-keep','delete-race-keep-key')};
 p.vaultObject={'delete-race-remove':p.vaultObject.remove,'delete-race-keep':p.vaultObject.keep};
 await service.repairAppBackup(p);const revision=(await service.getBackupSnapshot(p.appId)).revision;
 const pause=pauseQuery(vault,'updateOne',(filter,update)=>filter.vaultId==='delete-race-remove'&&update.$inc?.__v===1);
 const deletion=legacy.deleteVaults(p.appId,['delete-race-remove']);
 try {
  await Promise.race([pause.started,deletion.then(()=>{throw Error('vault deletion acknowledged before cleanup');})]);
  await service.repairAppBackup({...p,expectedRevision:revision,replaceCurrentState:true,vaultObject:{
   ...p.vaultObject,'delete-race-keep':vaultRecord('delete-race-keep','delete-race-keep-key','repaired-image'),
   'delete-race-new':vaultRecord('delete-race-new','delete-race-new-key')}});
  pause.release();assert.equal((await deletion).updated,true);
  const stored=await service.getBackupSnapshot(p.appId);
  assert.deepEqual([...stored.appImage.vaults].sort(),['delete-race-keep','delete-race-new']);
  assert.equal(stored.allVaultImages.find(v=>v.vaultId==='delete-race-keep').vault,'repaired-image');
  assert.equal(await map.countDocuments({signerId:'delete-race-remove-key'}),0);
  assert.equal(await map.countDocuments({signerId:'delete-race-new-key'}),1);
  assert.ok(pause.attempts()>1,'membership conflict retried vault deletion');
 } finally {pause.restore();await deletion;}
});

test('incremental vault writers preserve independent peer records and missing-record behavior',async()=>{
 const p=await payload('vault-owner-audit');p.vaultObject['owned-vault']=vaultRecord('owned-vault','owned-key');
 await service.repairAppBackup(p);const other=await payload('vault-other-owner');await service.repairAppBackup(other);
 assert.equal((await legacy.addVaultImage(other.appId,null,'owned-vault',null,'other-image',signerData('owned-key'))).updated,true);
 assert.equal((await vault.findOne({vaultId:'owned-vault'}).lean()).vault,'encrypted-vault');
 assert.equal((await service.getBackupSnapshot(other.appId)).allVaultImages[0].vault,'other-image');
 assert.equal((await legacy.deleteVaults(other.appId,['owned-vault'])).updated,true);
 assert.equal(await vault.countDocuments({vaultId:'owned-vault'}),1);
 assert.equal((await legacy.deleteVaults('missing-vault-owner',[])).updated,false);
 assert.equal(await legacy.archiveVault('missing-archive-vault'),false);
 await assert.rejects(legacy.createVaultMap(signerData('orphan-key'),'missing-map-vault'));
 assert.equal(await map.countDocuments({signerId:'orphan-key'}),0);
});

const plain = value => JSON.parse(JSON.stringify(value));
// Synthetic seed-derived authenticated ciphertext proves record isolation and
// decryption independently of Mongo metadata. No funded/customer keys are used.
function encryptedPeer(seed, value) {
 const key=crypto.createHash('sha256').update(seed).digest(),iv=crypto.randomBytes(12);
 const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
 const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
 return Buffer.concat([iv,cipher.getAuthTag(),ciphertext]).toString('base64');
}
function decryptedPeer(seed, image) {
 const bytes=Buffer.from(image,'base64'),key=crypto.createHash('sha256').update(seed).digest();
 const decipher=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
 decipher.setAuthTag(bytes.subarray(12,28));
 return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));
}
async function collaborativePeers(id) {
 const first=await payload(`${id}-first`),second=await payload(`${id}-second`);
 await service.repairAppBackup(first);await service.repairAppBackup(second);
 const vaultId=crypto.createHash('sha256').update(`${id}-same-keys-and-policy`).digest('hex').slice(-8);
 const signer=signerData(`${id}-shared-key`),seeds=['synthetic-first-seed','synthetic-second-seed'];
 const data=[{id:vaultId,participant:'first',nextFreeAddressIndex:4},{id:vaultId,participant:'second',nextFreeAddressIndex:9}];
 const images=data.map((value,i)=>encryptedPeer(seeds[i],value));
 assert.equal((await legacy.addVaultImage(first.appId,null,vaultId,null,images[0],signer)).updated,true);
 assert.equal((await legacy.addVaultImage(second.appId,null,vaultId,null,images[1],signer)).updated,true);
 return {first,second,vaultId,signer,seeds,data,images};
}

test('second collaborative participant stores and restores independently encrypted canonical wallet',async()=>{
 const p=await collaborativePeers('scoped-collaborative');
 for(const [index,account] of [p.first,p.second].entries()){
  const snapshot=await service.getBackupSnapshot(account.appId);
  assert.deepEqual(snapshot.appImage.vaults,[p.vaultId]);
  assert.deepEqual(plain(snapshot.unavailableVaultIds),[]);
  assert.equal(snapshot.allVaultImages[0].vault,p.images[index]);
  assert.deepEqual(decryptedPeer(p.seeds[index],snapshot.allVaultImages[0].vault),p.data[index]);
  assert.throws(()=>decryptedPeer(p.seeds[1-index],snapshot.allVaultImages[0].vault));
  assert.equal((await service.getAppBackupVaultImages(account.appId,[p.vaultId]))[0].vault,p.images[index]);
  const generic=await legacy.getAppImage(account.appId,'2.5.16');
  assert.equal(generic.allVaultImages[0].vault,p.images[index]);
  assert.deepEqual(decryptedPeer(p.seeds[index],generic.vaultImage.vault),p.data[index]);
 }
 assert.equal(await appVault.countDocuments({vaultId:p.vaultId}),2);
 assert.equal((await vault.findOne({vaultId:p.vaultId}).lean()).vault,p.images[0]);
 await assert.rejects(appVault.create({appId:p.first.appId,vaultId:p.vaultId,vault:'duplicate',signerIds:[]}),error=>error.code===11000);
 const before=(await service.getBackupSnapshot(p.first.appId)).revision;
 assert.notEqual(await legacy.updateVault(p.vaultId,encryptedPeer(p.seeds[1],{...p.data[1],nextFreeAddressIndex:10}),p.second.appId,false),false);
 assert.equal((await service.getBackupSnapshot(p.first.appId)).revision,before);
});

test('current and compatible update route preserve scoped ownership and forward archive metadata',async()=>{
 const p=await collaborativePeers('scoped-update-route');
 const handler=vaultUpdateRouteHandler();let status,body;
 const response={status(code){status=code;return this;},json(value){body=value;return this;}};
 await handler({body:{appId:p.second.appId,isUpdate:true,vaultId:p.vaultId,vault:p.images[1],isArchived:true}},response);
 assert.equal(status,200);assert.equal(body.updated,true);
 assert.equal((await service.getBackupSnapshot(p.second.appId)).allVaultImages[0].isArchived,true);
 assert.equal((await service.getBackupSnapshot(p.first.appId)).allVaultImages[0].isArchived,false);
 assert.equal(await map.countDocuments({vaultId:p.vaultId}),1,'active peer lookup survives archive');
 // Older shared-wallet updates cannot identify the participant; reject safely.
 await handler({body:{isUpdate:true,vaultId:p.vaultId,vault:p.images[0]}},response);
 assert.equal(status,503);assert.equal(body.updated,false);
 assert.equal((await service.getBackupSnapshot(p.first.appId)).allVaultImages[0].vault,p.images[0]);
 assert.equal((await service.getBackupSnapshot(p.second.appId)).allVaultImages[0].vault,p.images[1]);
 assert.equal((await legacy.addVaultImage(p.second.appId,null,p.vaultId,null,p.images[1],p.signer)).updated,true);
 assert.equal((await service.getBackupSnapshot(p.second.appId)).allVaultImages[0].isArchived,true,'missing old-client flag preserves archive state');
 await handler({body:{appId:p.second.appId,isUpdate:true,vaultId:p.vaultId,vault:p.images[1],isArchived:'false'}},response);
 assert.equal(status,503);assert.equal(body.updated,false);
});

test('full peer repair and each deletion path preserve another participant recovery data',async()=>{
 for(const operation of ['incremental','current-state','delete-backup']){
  const p=await collaborativePeers(`shared-removal-${operation}`);
  const before=await service.getBackupSnapshot(p.second.appId);
  const repaired=encryptedPeer(p.seeds[1],{...p.data[1],nextFreeAddressIndex:12});
  await service.repairAppBackup({...p.second,expectedRevision:before.revision,vaultObject:{[p.vaultId]:vaultRecord(p.vaultId,p.signer[0].signerId,repaired)}});
  if(operation==='incremental') assert.equal((await legacy.deleteVaults(p.first.appId,[p.vaultId])).updated,true);
  if(operation==='current-state') await service.repairAppBackup({...p.first,expectedRevision:(await service.getBackupSnapshot(p.first.appId)).revision,replaceCurrentState:true,vaultObject:{}});
  if(operation==='delete-backup') assert.equal((await legacy.deleteBackup(p.first.appId)).updated,true);
  assert.deepEqual((await service.getBackupSnapshot(p.first.appId)).appImage.vaults,[]);
  assert.equal(await appVault.countDocuments({appId:p.first.appId,vaultId:p.vaultId}),0);
  const survivor=await service.getBackupSnapshot(p.second.appId);
  assert.deepEqual(decryptedPeer(p.seeds[1],survivor.allVaultImages[0].vault),{...p.data[1],nextFreeAddressIndex:12});
  assert.equal(await vault.countDocuments({vaultId:p.vaultId}),1);
  assert.equal(await map.countDocuments({vaultId:p.vaultId}),1);
  assert.equal((await legacy.deleteVaults(p.second.appId,[p.vaultId])).updated,true);
  assert.equal(await vault.countDocuments({vaultId:p.vaultId}),0);
  assert.equal(await appVault.countDocuments({vaultId:p.vaultId}),0);
  assert.equal(await map.countDocuments({vaultId:p.vaultId}),0);
 }
});

test('concurrent final participant unlinks retry and leave no orphan global or scoped backup',async()=>{
 const p=await collaborativePeers('shared-final-unlink');
 const pause=pauseQuery(vault,'updateOne',(filter,update)=>filter.vaultId===p.vaultId&&update.$inc?.__v===1);
 const firstDeletion=legacy.deleteVaults(p.first.appId,[p.vaultId]);
 try {
  await Promise.race([pause.started,firstDeletion.then(()=>{throw Error('first unlink completed before race gate');})]);
  assert.equal((await legacy.deleteVaults(p.second.appId,[p.vaultId])).updated,true);
  pause.release();assert.equal((await firstDeletion).updated,true);
  assert.equal(await vault.countDocuments({vaultId:p.vaultId}),0);
  assert.equal(await appVault.countDocuments({vaultId:p.vaultId}),0);
  assert.equal(await map.countDocuments({vaultId:p.vaultId}),0);
  assert.deepEqual((await app.findOne({appId:p.first.appId}).lean()).vaults,[]);
  assert.deepEqual((await app.findOne({appId:p.second.appId}).lean()).vaults,[]);
 } finally {pause.restore();await firstDeletion;}
});

test('identical legacy-owner relink invalidates concurrent final peer cleanup',async()=>{
 const p=await collaborativePeers('identical-owner-relink');
 assert.equal((await legacy.deleteVaults(p.first.appId,[p.vaultId])).updated,true);
 const pause=pauseQuery(vault,'updateOne',(filter,update)=>filter.vaultId===p.vaultId&&update.$inc?.__v===1);
 const lastDeletion=legacy.deleteVaults(p.second.appId,[p.vaultId]);
 try {
  await Promise.race([pause.started,lastDeletion.then(()=>{throw Error('unlink completed before relink gate');})]);
  assert.equal((await legacy.addVaultImage(p.first.appId,null,p.vaultId,null,p.images[0],p.signer)).updated,true);
  pause.release();assert.equal((await lastDeletion).updated,true);
  assert.equal((await service.getBackupSnapshot(p.first.appId)).allVaultImages[0].vault,p.images[0]);
  assert.equal(await vault.countDocuments({vaultId:p.vaultId}),1);
  assert.equal(await map.countDocuments({vaultId:p.vaultId}),1);
  assert.deepEqual((await service.getBackupSnapshot(p.second.appId)).appImage.vaults,[]);
 } finally {pause.restore();await lastDeletion;}
});

test('standalone legacy map batch cannot commit lookup after its vault is deleted',async()=>{
 const p=await payload('map-delete-race');p.vaultObject['map-race-vault']=vaultRecord('map-race-vault','map-race-old-key');await service.repairAppBackup(p);
 const pause=pauseQuery(vault,'updateOne',(filter,update)=>filter.vaultId==='map-race-vault'&&update.$inc?.__v===1);
 const creation=legacy.createVaultMap(signerData('map-race-new-key'),'map-race-vault');
 const outcome=creation.then(()=>null,error=>error);
 try {
  await Promise.race([pause.started,outcome.then(()=>{throw Error('map operation completed before race gate');})]);
  assert.equal((await legacy.deleteVaults(p.appId,['map-race-vault'])).updated,true);
  pause.release();assert.match((await outcome).message,/No vault image/);
  assert.equal(await map.countDocuments({signerId:'map-race-new-key'}),0);
 } finally {pause.restore();await outcome;}
});

test('surviving same-owner legacy image is readable without creating a scoped copy',async()=>{
 const p=await payload('legacy-owned-fallback');await service.repairAppBackup(p);
 await app.updateOne({appId:p.appId},{$set:{vaults:['legacy-owned-vault']}});
 await vault.create({appId:p.appId,vaultId:'legacy-owned-vault',vault:'own-legacy-ciphertext',signerIds:[],isArchived:true});
 const result=await service.getBackupSnapshot(p.appId);
 assert.equal(result.allVaultImages[0].vault,'own-legacy-ciphertext');
 assert.deepEqual(plain(result.unavailableVaultIds),[]);
 assert.equal((await service.getAppBackupVaultImages(p.appId,['legacy-owned-vault']))[0].isArchived,true);
 assert.equal(await appVault.countDocuments({appId:p.appId}),0,'read-only fallback does not migrate records');
});

test('overwritten or absent legacy images report exact unavailable IDs without exposing peer ciphertext',async()=>{
 const p=await payload('legacy-lost-peer');await legacy.backupAllSignersAndVaults(p);
 await app.updateOne({appId:p.appId},{$set:{vaults:['legacy-overwritten','legacy-absent']}});
 await vault.create({appId:'foreign-peer',vaultId:'legacy-overwritten',vault:'foreign-ciphertext',signerIds:[]});
 const snapshot=await service.getBackupSnapshot(p.appId);
 assert.deepEqual(snapshot.appImage.vaults,['legacy-overwritten','legacy-absent']);
 assert.deepEqual(plain(snapshot.unavailableVaultIds),['legacy-absent','legacy-overwritten']);
 assert.deepEqual(snapshot.allVaultImages,[]);
 assert.ok(!JSON.stringify(snapshot).includes('foreign-ciphertext'));
 await assert.rejects(service.getAppBackupVaultImages(p.appId,snapshot.appImage.vaults),/Incomplete backup/);
 await assert.rejects(legacy.getAppImage(p.appId,'2.5.16'),/unavailable/);
 await assert.rejects(legacy.backupAllSignersAndVaults({...p,vaultObject:{'legacy-overwritten':vaultRecord('legacy-overwritten','lost-key','local-ciphertext'),'legacy-absent':vaultRecord('legacy-absent','missing-key')}}),/Backup changed/);
 assert.equal(await appVault.countDocuments({appId:p.appId}),0);
});

test('explicit local resubmission restores unavailable own scope and keeps surviving peer ciphertext',async()=>{
 const p=await payload('legacy-explicit-resubmit');await service.repairAppBackup(p);
 await app.updateOne({appId:p.appId},{$set:{vaults:['legacy-resubmit-vault']}});
 await vault.create({appId:'surviving-peer',vaultId:'legacy-resubmit-vault',vault:'surviving-peer-ciphertext',signerIds:[]});
 const unavailable=await service.getBackupSnapshot(p.appId),local=encryptedPeer('synthetic-resubmit-seed',{id:'legacy-resubmit-vault',nextFreeAddressIndex:7});
 const request={...p,expectedRevision:unavailable.revision,replaceCurrentState:true,vaultObject:{'legacy-resubmit-vault':vaultRecord('legacy-resubmit-vault','resubmit-key',local)}};
 await app.updateOne({appId:p.appId},{$set:{'wallets.newer':'newer-wallet'}});
 await assert.rejects(service.repairAppBackup(request),service.BackupConflict);
 assert.equal(await appVault.countDocuments({appId:p.appId}),0);
 request.expectedRevision=(await service.getBackupSnapshot(p.appId)).revision;
 request.walletObject={...request.walletObject,newer:'newer-wallet'};
 await service.repairAppBackup(request);
 const restored=await service.getBackupSnapshot(p.appId);
 assert.deepEqual(plain(restored.unavailableVaultIds),[]);
 assert.notEqual(restored.revision,unavailable.revision);
 assert.deepEqual(decryptedPeer('synthetic-resubmit-seed',restored.allVaultImages[0].vault),{id:'legacy-resubmit-vault',nextFreeAddressIndex:7});
 assert.equal((await vault.findOne({vaultId:'legacy-resubmit-vault'}).lean()).vault,'surviving-peer-ciphertext');
});

test('scoped initialization failure is safe, retryable, and successful initialization is cached',async()=>{
 let attempts=0,indexCalls=0;
 const model={find:(...args)=>appVault.find(...args),init:async()=>{attempts++;throw Error('disposable index initialization failure');},collection:{createIndex:async(...args)=>{indexCalls++;return appVault.collection.createIndex(...args);}}};
 const isolated=load('src/services/backupSnapshot.ts',{'../db':{getAppVaultImageModel:()=>model,getAppImageModel:()=>app,getVaultImageModel:()=>vault,getLabelModel:()=>label}});
 const count=await app.countDocuments();
 await assert.rejects(isolated.getBackupSnapshot('initialization-fixture'),/initialization failure/);
 assert.equal(await app.countDocuments(),count);
 await isolated.getBackupSnapshot('initialization-fixture');await isolated.getBackupSnapshot('initialization-fixture');
 assert.equal(attempts,1);assert.equal(indexCalls,1);
});

test('pending scoped initialization has a bounded failure before any transaction or record mutation',async()=>{
 let firstDeadline=true,initCalls=0,indexCalls=0;
 const model={find:(...args)=>appVault.find(...args),init:()=>{initCalls++;return new Promise(()=>{});},collection:{createIndex:async(...args)=>{indexCalls++;return appVault.collection.createIndex(...args);}}};
 const isolated=load('src/services/backupSnapshot.ts',{'../db':{getAppVaultImageModel:()=>model,getAppImageModel:()=>app,getVaultImageModel:()=>vault,getLabelModel:()=>label},timers:{setTimeout:(callback,milliseconds)=>{if(firstDeadline){firstDeadline=false;queueMicrotask(callback);return 0;}return setTimeout(callback,milliseconds);},clearTimeout}});
 const count=await app.countDocuments();
 await assert.rejects(isolated.getBackupSnapshot('initialization-deadline'),/initialization unavailable/);
 assert.equal(await app.countDocuments(),count);
 await isolated.getBackupSnapshot('initialization-deadline');await isolated.getBackupSnapshot('initialization-deadline');
 assert.equal(initCalls,1);assert.equal(indexCalls,1,'timed-out init retries required index and caches success');
});

test('required compound unique index is explicitly ensured even when model initialization creates none',async()=>{
 let indexCalls=0;
 const model={find:(...args)=>appVault.find(...args),init:async()=>undefined,collection:{createIndex:async(fields,options)=>{
  indexCalls++;assert.deepEqual(plain(fields),{appId:1,vaultId:1});assert.equal(options.unique,true);assert.equal(options.maxTimeMS,15000);
  return appVault.collection.createIndex(fields,options);
 }}};
 const isolated=load('src/services/backupSnapshot.ts',{'../db':{getAppVaultImageModel:()=>model,getAppImageModel:()=>app,getVaultImageModel:()=>vault,getLabelModel:()=>label}});
 await isolated.getBackupSnapshot('initialization-without-auto-index');await isolated.getBackupSnapshot('initialization-without-auto-index');
 assert.equal(indexCalls,1);
});

test('older no-account update succeeds only for one matching legacy owner',async()=>{
 const p=await payload('legacy-single-owner-update');p.vaultObject['legacy-single-owner-vault']=vaultRecord('legacy-single-owner-vault','legacy-single-key','old-ciphertext');
 await service.repairAppBackup(p);
 assert.notEqual(await legacy.updateVault('legacy-single-owner-vault','updated-ciphertext'),false);
 assert.equal((await service.getBackupSnapshot(p.appId)).allVaultImages[0].vault,'updated-ciphertext');
 const other=await payload('legacy-ambiguous-update');await service.repairAppBackup(other);
 assert.equal((await legacy.addVaultImage(other.appId,null,'legacy-single-owner-vault',null,'other-ciphertext',signerData('legacy-single-key'))).updated,true);
 assert.equal(await legacy.updateVault('legacy-single-owner-vault','unknown-participant-ciphertext'),false);
 assert.equal((await service.getBackupSnapshot(p.appId)).allVaultImages[0].vault,'updated-ciphertext');
 assert.equal((await service.getBackupSnapshot(other.appId)).allVaultImages[0].vault,'other-ciphertext');
});

test('duplicate legacy vault and label references remain readable and normalize only on explicit write',async()=>{
 const p=await payload('legacy-duplicate-refs');
 const image=encryptedPeer('synthetic-duplicate-seed',{id:'legacy-duplicate-vault',nextFreeAddressIndex:3});
 p.vaultObject['legacy-duplicate-vault']=vaultRecord('legacy-duplicate-vault','duplicate-key',image);
 p.labels=[{id:'legacy-duplicate-label',content:encryptedPeer('synthetic-duplicate-seed',{name:'synthetic-label'})}];
 await service.repairAppBackup(p);
 await app.updateOne({appId:p.appId},{$set:{vaults:['legacy-duplicate-vault','legacy-duplicate-vault'],labels:['legacy-duplicate-label','legacy-duplicate-label']}});
 const snapshot=await service.getBackupSnapshot(p.appId),restored=await legacy.getAppImage(p.appId,'2.5.16');
 assert.deepEqual(snapshot.appImage.vaults,['legacy-duplicate-vault']);
 assert.deepEqual(snapshot.appImage.labels,['legacy-duplicate-label']);
 assert.equal(snapshot.allVaultImages.length,1);assert.equal(snapshot.labels.length,1);
 assert.deepEqual(decryptedPeer('synthetic-duplicate-seed',restored.allVaultImages[0].vault),{id:'legacy-duplicate-vault',nextFreeAddressIndex:3});
 assert.deepEqual(decryptedPeer('synthetic-duplicate-seed',restored.labels[0].content),{name:'synthetic-label'});
 assert.deepEqual((await app.findOne({appId:p.appId}).lean()).vaults,['legacy-duplicate-vault','legacy-duplicate-vault']);
 assert.deepEqual((await app.findOne({appId:p.appId}).lean()).labels,['legacy-duplicate-label','legacy-duplicate-label']);
 await service.repairAppBackup({...p,expectedRevision:snapshot.revision});
 assert.deepEqual((await app.findOne({appId:p.appId}).lean()).vaults,['legacy-duplicate-vault']);
 assert.deepEqual((await app.findOne({appId:p.appId}).lean()).labels,['legacy-duplicate-label']);
});

test('generic recovery reads one coherent snapshot during repair or deletion',async()=>{
 for(const mutation of ['repair','delete']){
  const p=await payload(`coherent-reader-${mutation}`),id=`coherent-vault-${mutation}`;
  p.vaultObject[id]=vaultRecord(id,`coherent-key-${mutation}`,'old-vault-ciphertext');
  p.labels=[{id:`coherent-label-${mutation}`,content:'old-label-ciphertext'}];
  await service.repairAppBackup(p);const before=await service.getBackupSnapshot(p.appId);
  const pause=pauseQuery(appVault,'find',filter=>filter.appId===p.appId);
  const reading=legacy.getAppImage(p.appId,'2.5.16');
  try {
   await Promise.race([pause.started,reading.then(()=>{throw Error('recovery read completed before race gate');})]);
   if(mutation==='repair') await service.repairAppBackup({...p,expectedRevision:before.revision,walletObject:{w:'new-wallet-ciphertext'},vaultObject:{[id]:vaultRecord(id,`coherent-key-${mutation}`,'new-vault-ciphertext')},labels:[{id:`coherent-label-${mutation}`,content:'new-label-ciphertext'}]});
   else await legacy.deleteBackup(p.appId);
   pause.release();const image=await reading;
   assert.equal(image.appImage.wallets.w,'encrypted-wallet');
   assert.deepEqual(image.appImage.vaults,[id]);
   assert.equal(image.allVaultImages[0].vault,'old-vault-ciphertext');
   assert.equal(image.labels[0].content,'old-label-ciphertext');
   const after=await legacy.getAppImage(p.appId,'2.5.16');
   if(mutation==='repair'){
    assert.equal(after.appImage.wallets.w,'new-wallet-ciphertext');
    assert.equal(after.allVaultImages[0].vault,'new-vault-ciphertext');
    assert.equal(after.labels[0].content,'new-label-ciphertext');
   }else{
    assert.deepEqual(after.appImage.vaults,[]);assert.equal(after.allVaultImages.length,0);assert.equal(after.labels.length,0);
   }
  } finally {pause.restore();await reading;}
 }
 const absent=await legacy.getAppImage('coherent-absent','2.5.16');
 assert.equal(absent.appImage.version,'2.5.16');assert.deepEqual(plain(absent.appImage.vaults),[]);
});

test('runtime operator-object or absent account inputs are rejected before any backup query',async()=>{
 const p=await payload('operator-input-seeded-account');p.vaultObject['operator-input-vault']=vaultRecord('operator-input-vault','operator-input-key','private-synthetic-ciphertext');
 await service.repairAppBackup(p);
 const original=app.findOne;let queries=0;
 app.findOne=function(...args){queries++;return original.apply(this,args);};
 try {
  for(const value of [{$ne:null},{$in:[p.appId]},undefined,null,'',[]]){
   await assert.rejects(service.getBackupSnapshot(value),/Invalid backup account/);
   await assert.rejects(service.getAppBackupVaultImages(value,['operator-input-vault']),/Invalid backup account/);
   await assert.rejects(legacy.getAppImage(value,'2.5.16'),/Invalid backup account/);
  }
  assert.equal(queries,0);
 } finally {app.findOne=original;}
 assert.equal((await service.getBackupSnapshot(p.appId)).allVaultImages[0].vault,'private-synthetic-ciphertext');
});

test('current archive and reinstate route rebuilds an unshared active signer lookup',async()=>{
 const p=await payload('archive-reinstate'),id='archive-reinstate-vault',signers=signerData('archive-reinstate-key');
 p.vaultObject[id]=vaultRecord(id,signers[0].signerId);await service.repairAppBackup(p);
 const handler=vaultUpdateRouteHandler();let status,body;
 const response={status(code){status=code;return this;},json(value){body=value;return this;}};
 for(const isArchived of [true,false]){
  await handler({body:{appId:p.appId,isUpdate:true,vaultId:id,vault:'encrypted-vault',isArchived,signersData:signers}},response);
  assert.equal(status,200);assert.equal(body.updated,true);
  assert.equal((await service.getBackupSnapshot(p.appId)).allVaultImages[0].isArchived,isArchived);
  assert.equal(await map.countDocuments({vaultId:id}),isArchived?0:1);
 }
 assert.equal((await map.findOne({signerId:signers[0].signerId}).lean()).xfpHash,signers[0].xfpHash);
});

test('minimized empty legacy maps return valid empty shapes without dropping unavailable references',async()=>{
 const id='minimized-empty-account',vaultId='minimized-unavailable-vault';
 await app.create({appId:id,publicId:`public-${id}`,version:'2.5.16',wallets:{},signers:{},nodes:[],vaults:[vaultId],labels:[]});
 assert.equal((await app.findOne({appId:id}).lean()).wallets,undefined);
 assert.equal((await app.findOne({appId:id}).lean()).signers,undefined);
 const snapshot=await service.getBackupSnapshot(id);
 assert.deepEqual(plain(snapshot.appImage.wallets),{});assert.deepEqual(plain(snapshot.appImage.signers),{});
 assert.deepEqual(plain(snapshot.appImage.nodes),[]);assert.deepEqual(snapshot.appImage.vaults,[vaultId]);assert.deepEqual(plain(snapshot.appImage.labels),[]);
 assert.deepEqual(plain(snapshot.unavailableVaultIds),[vaultId]);assert.deepEqual(snapshot.allVaultImages,[]);
 await assert.rejects(legacy.getAppImage(id,'2.5.16'),/unavailable/);
 assert.equal((await app.findOne({appId:id}).lean()).wallets,undefined,'normalization remains read-only');
});
