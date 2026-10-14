import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {replayDecisionV21} from './decision-v21-replay.mts';
const dataset=()=>JSON.parse(readFileSync(new URL('../../../tests/fixtures/decision-v21/scenarios.json',import.meta.url),'utf8'));
test('24 bounded synthetic history replays cover all levels with no API/platform execution',async()=>{
  const report=await replayDecisionV21(dataset());assert.equal(report.scenarios,24);assert.equal(report.matched,24);assert.equal(report.externalCalls,0);assert.equal(report.platformCalls,0);assert.equal(report.apiCost,0);assert.equal(report.realModelQuality,'not_evaluated');
  assert.equal(report.complexEmotionMissRate,0);assert.equal(report.unnecessaryUpgradeRate,0);assert.equal(report.jsonErrors,0);assert.equal(report.deepAnalysisCalls,8);
  assert.equal(report.rows.every(r=>r.cutoffExcludedMessages===1),true);assert.equal(report.rows[0]!.cutoffExcludedFacts,1);assert.equal(report.rows[0]!.visibleFactCount,1);
  assert.equal(report.rows.filter(r=>r.actualLevel==='L4').every(r=>r.generationCalls===0),true);
});
test('replay requires authorization, deidentification, scoped IDs and valid labels',async()=>{
  for(const mutation of [(d:any)=>d.authorization.deidentified=false,(d:any)=>d.authorization.ownerAuthorized=false,(d:any)=>d.cases[0].sample.messages[0].text='联系人 wxid_private',(d:any)=>d.cases[0].expectedLevel='L5']){const d=dataset();mutation(d);await assert.rejects(()=>replayDecisionV21(d));}
});
