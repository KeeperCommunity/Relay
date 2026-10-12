const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
function route(service, name = '/getAppImage', dependencies = {}){
 const source=ts.createSourceFile('routes.ts',fs.readFileSync(path.join(__dirname,'../src/routes/routes.ts'),'utf8'),ts.ScriptTarget.Latest,true);let registration,handler;
 function visit(n){if(ts.isCallExpression(n)&&n.expression.getText(source)==='router.post'&&n.arguments[0]?.text===name)registration=n;ts.forEachChild(n,visit);}visit(source);assert.ok(registration);
 vm.runInNewContext(ts.transpileModule(registration.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText,{...dependencies,bhr:service,router:{post:(_p,h)=>handler=h}});return handler;
}
test('recovery backend failure completes with a retryable response and no sensitive exception',async()=>{
 let status,body;const res={status(c){status=c;return this},json(b){body=b;return this}};
 await route({getAppImage:async()=>{throw Error('sensitive database details')}})({body:{appId:'disposable'},headers:{appversion:'2.5.17'}},res);
 assert.equal(status,503);assert.equal(body.err,'Backup temporarily unavailable');
});
test('successful encrypted recovery response remains unchanged',async()=>{
 let status,body;const image={appImage:{wallets:{w:'ciphertext'}},labels:[],allVaultImages:[]};const res={status(c){status=c;return this},json(b){body=b;return this}};
 await route({getAppImage:async()=>image})({body:{appId:'disposable'},headers:{appversion:'2.5.17'}},res);assert.equal(status,200);assert.equal(body,image);
});

const mockResponse = () => {
 let status, body;
 return {status(c){status=c;return this;},json(b){body=b;return this;},get result(){return {status,body};}};
};
for (const appId of [undefined, '', {}, {$ne:null}]) test(`snapshot rejects invalid account before database access: ${JSON.stringify(appId)}`, async () => {
 let calls=0; const res=mockResponse();
 await route({}, '/getBackupSnapshot', {getBackupSnapshot:async()=>{calls++;}})({body:{appId}},res);
 assert.equal(res.result.status,400); assert.equal(calls,0);
});
test('snapshot database failure terminates with a fixed retryable error',async()=>{
 const res=mockResponse();
 await route({}, '/getBackupSnapshot', {getBackupSnapshot:async()=>{throw Error('synthetic-private-canary');}})({body:{appId:'disposable'}},res);
 assert.equal(res.result.status,503); assert.equal(res.result.body.error,'Backup snapshot unavailable');
});
test('snapshot success preserves revision and encrypted records',async()=>{
 const res=mockResponse(), snapshot={revision:'a'.repeat(64),appImage:{wallets:{w:'synthetic-ciphertext'}},labels:[],allVaultImages:[]};
 await route({}, '/getBackupSnapshot', {getBackupSnapshot:async()=>snapshot})({body:{appId:'disposable'}},res);
 assert.equal(res.result.status,200);assert.equal(res.result.body,snapshot);
});
class BackupConflict extends Error {}
class InvalidBackupRequest extends Error {}
for (const [error,status,message] of [[new BackupConflict(),409,'BACKUP_CHANGED'],[new InvalidBackupRequest(),400,'BACKUP_NOT_UPDATED'],[new Error('synthetic-private-canary'),503,'BACKUP_NOT_UPDATED']]) test(`repair failure returns stable code ${status}`,async()=>{
 const res=mockResponse();
 await route({}, '/repairAppBackup', {BackupConflict,InvalidBackupRequest,repairAppBackup:async()=>{throw error;}})({body:{appId:'disposable'}},res);
 assert.equal(res.result.status,status); assert.equal(res.result.body.updated,false); assert.equal(res.result.body.error,message);
});
