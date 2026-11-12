// 显式列出离线检查；不执行会发消息、写业务表的 selftest-999 或 test-points-reminder。
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const files=[
  'scripts/test-admin-ledgers.js','scripts/test-delivery-confirmation.js','scripts/test-batch.js','scripts/test-notification-optout.js','scripts/test-release-draft.js',
  'scripts/test-scene-flow.js','scripts/test-scene-identity.js','scripts/test-schedule-sync.js',
  'scripts/test-schedule-sync_v002.js','scripts/test-status-vocab.js','scripts/test-tbpz-profiles.js',
  'admin/test.js','admin/test-upgrade.js','scripts/test-download.js','scripts/test-runtime-audit.js',
  'scripts/test-reliability.js','scripts/test-lock.js','scripts/test-action-safety.js',
  'scripts/test-upload-verification.js','scripts/test-weekly-track.js',
];
let failed=0;
for(const file of files){
  const result=spawnSync(process.execPath,['--require',path.join(__dirname,'test-environment.js'),file],{cwd:root,encoding:'utf8',timeout:45000});
  console.log(`${result.status===0?'PASS':'FAIL'} ${file}`);
  if(result.status!==0){failed++;console.error(result.error?.message||((result.stdout||'')+(result.stderr||'')));}
}
console.log(`${files.length-failed}/${files.length} 项离线检查通过`);
if(failed)process.exitCode=1;
