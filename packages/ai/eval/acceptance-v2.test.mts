import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {acceptanceGate,blindPack,scoreBlindRatings,latency,recallAt5,ratio,type AcceptanceEvidenceV2} from './acceptance-v2.mts';
import {prepareScenariosV2,replayScenariosV2} from './scenario-replay-v2.mts';
const dataset=JSON.parse(await readFile(new URL('../../../tests/fixtures/p6/chinese-scenarios-v2.json',import.meta.url),'utf8'));
test('160 labelled Chinese scenarios exercise both paths with cutoff, schema, quality and manual approval',async()=>{
  const result=await replayScenariosV2(dataset);assert.equal(result.report.scenarios,160);assert.equal(result.report.failed,0,JSON.stringify(result.report.rows.filter(r=>r.failures.length)));assert.equal(result.report.externalCalls,0);assert.equal(result.report.platformCalls,0);
  assert.ok(result.report.rows.every(r=>r.cutoffExcludedMessages===1));assert.ok(Object.values(result.report.categories).every(n=>n===20));assert.equal(result.report.humanPreference,null);
});
test('P6 dataset refuses duplicate labels, private identifiers and hidden authority fields',()=>{
  for(const mutate of [(d:any)=>d.cases.push(d.cases[0]),(d:any)=>d.cases[0].sample.messages[0].text='联系我 wxid_private',(d:any)=>d.cases[0].sample.policy.autoSend=true]){const d=structuredClone(dataset);mutate(d);assert.throws(()=>prepareScenariosV2(d));}
});
const evidence=():AcceptanceEvidenceV2=>({datasetKind:'synthetic',scenarios:160,contactLeaks:0,duplicateSends:0,staleSends:0,unauthorizedHighRiskSends:0,recall:ratio(40,40),boundaryRecall:ratio(20,20),callLedgerCoverage:ratio(100,100),safeFailure:ratio(5,5),rollbackPassed:true,humanBlindRatings:0,realModelCalls:0,perContactAuthorized:false});
test('passing synthetic metrics never authorize production promotion or automatic sending',()=>{const result=acceptanceGate(evidence());assert.equal(result.offlinePassed,true);assert.equal(result.releaseReady,false);assert.equal(result.automaticSendAuthorized,false);assert.equal(result.pending.length,4);});
test('empty denominators, insufficient recall and unsafe sends fail acceptance instead of becoming zero success',()=>{
  for(const patch of [{recall:ratio(0,0)},{recall:ratio(8,10)},{boundaryRecall:ratio(9,10)},{contactLeaks:1},{duplicateSends:1},{staleSends:1},{unauthorizedHighRiskSends:1},{callLedgerCoverage:ratio(98,100)},{safeFailure:ratio(9,10)},{rollbackPassed:false}])assert.equal(acceptanceGate({...evidence(),...patch}).offlinePassed,false);
  assert.throws(()=>acceptanceGate({...evidence(),recall:{numerator:0,denominator:0,rate:1}}),/INVALID_METRIC/);
  assert.deepEqual(recallAt5([{expectedIds:['a','b'],rankedIds:['a','x','y','z','w','b']}]),ratio(1,2));assert.deepEqual(latency([]),{samples:0,p50Ms:null,p95Ms:null,maxMs:null});
});
test('blind packs omit provider metadata and rating aggregation rejects duplicate or unknown votes',()=>{
  const a=[{clientAlternativeKey:'a',strategySummary:'provider-secret',parts:[{clientPartKey:'p',sequence:1,type:'text' as const,content:'谢谢你告诉我'}]}];
  const result=blindPack([{sampleId:'daily-01',left:{provider:'model-x',alternatives:a},right:{provider:'model-y',alternatives:a}}],()=>1);
  assert.equal(JSON.stringify(result.pack).includes('model-'),false);assert.equal(JSON.stringify(result.pack).includes('provider-secret'),false);
  const ratings=[{sampleId:'daily-01',reviewerId:'reviewer1',choice:'A' as const}];assert.equal(scoreBlindRatings(result.key,ratings).wins['model-y'],1);
  assert.throws(()=>scoreBlindRatings(result.key,[...ratings,...ratings]),/INVALID_BLIND_RATING/);assert.throws(()=>scoreBlindRatings(result.key,[{...ratings[0]!,sampleId:'unknown'}]),/INVALID_BLIND_RATING/);
});
