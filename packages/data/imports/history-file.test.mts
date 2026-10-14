import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHistoryFile,previewHistory} from './history-file.mts';
test('history files preserve unknown time and require explicit speakers and timezones',()=>{
 const rows=parseHistoryFile('json',JSON.stringify([{speaker:'OTHER',text:'喜欢面条',timestamp:null},{speaker:'UNKNOWN',text:'待核对',timestamp:'2026-10-13T10:00:00+08:00'}]));
 assert.equal(rows[0]!.timestamp,null);assert.equal(rows[0]!.uncertain,false);assert.equal(rows[1]!.uncertain,true);assert.equal(rows[1]!.timestamp,'2026-10-13T02:00:00.000Z');
 for(const v of [{speaker:'张三',text:'昵称不能猜身份'},{speaker:'OTHER',text:'你好',timestamp:'2026-10-13 10:00'}])assert.throws(()=>parseHistoryFile('json',JSON.stringify([v])),/VALIDATION/);
 assert.throws(()=>parseHistoryFile('json','[]'),/VALIDATION/);
});
test('CSV and TSV support quoted multiline text, escaped quotes and BOM',()=>{
 const rows=parseHistoryFile('csv','\uFEFFspeaker,text,timestamp\r\nME,"他说""你好""\n下一行",\r\nOTHER,好的,2026-10-13T10:00:00+08:00');
 assert.equal(rows[0]!.text,'他说"你好"\n下一行');assert.equal(rows.length,2);
 assert.equal(parseHistoryFile('tsv','speaker\ttext\ntOTHER\t不正确'.replace('tOTHER','OTHER'))[0]!.speaker,'OTHER');
 assert.throws(()=>parseHistoryFile('csv','speaker,text\nME,"没闭合'),/VALIDATION/);
});
test('stable IDs dedup exactly; matching short speech only suggests a duplicate',()=>{
 const existing=[{id:'stored',platformMessageId:'qq-1',speaker:'OTHER' as const,text:'好的',timestamp:'2026-10-13T02:00:00.000Z'}];
 const rows=parseHistoryFile('json',JSON.stringify([{messageId:'qq-1',speaker:'OTHER',text:'好的',timestamp:'2026-10-13T10:00:00+08:00'},{speaker:'OTHER',text:'好的',timestamp:null}]));
 const preview=previewHistory(rows,existing);assert.equal(preview[0]!.duplicateOf,'stored');assert.equal(preview[1]!.duplicateOf,null);assert.deepEqual(preview[1]!.duplicateCandidates,['stored']);
 assert.throws(()=>previewHistory([{...rows[0]!,text:'不同原文'}],existing),/CONFLICT/);
 assert.equal(previewHistory(rows,[])[0]!.exactDuplicate,false);
});
