package cn.replyassistant.domain

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.encodeToJsonElement
import org.junit.Assert.*
import org.junit.Test

class LinkedCorrectionsTest {
 private val json=Json {encodeDefaults=true}
 private fun row(m:ChatMessage,version:Long=1,deleted:Boolean=false,resolved:Boolean=false)=LinkRecord("phone:device:${m.id}","message",if(deleted)null else json.encodeToJsonElement(m.linkMessage()),version,version+1,deleted,resolved)
 private fun archive():ChatArchive {val m=ChatMessage(id="one",speaker=Speaker.OTHER,text="识别错字",origin=Origin.SCREENSHOT,sourceId="page");val a=ChatArchive(name="合成",revision=4,messages=listOf(m));val p=a.linkProfile();return a.copy(desktop=LinkedArchive("group",deviceId="device",exportedProfile=p,records=listOf(row(m),LinkRecord("profile","profile",json.encodeToJsonElement(p),1,1,false))))}
 private fun records(a:ChatArchive,r:LinkRecord)=a.desktop!!.records.filterNot {it.id==r.id}+r
 @Test fun pcCorrectionChangesLocalEvidenceAndExpiresDraftWithoutLosingManualText(){
  val a=archive().copy(draft=ReplyDraft(contextRevision=4,alternatives=listOf("原回复"),text="本人手工修改",manuallyEdited=true),memory=RelationshipMemory(consent=true,entries=listOf(MemoryEntry(id="memory",kind="fact",text="旧内容",sourceIds=listOf("one")))))
  val corrected=a.messages[0].copy(text="纠正后的原文",speaker=Speaker.ME,uncertain=true)
  val received=a.desktop!!.copy(cursor=3,records=records(a,row(corrected,2)))
  val result=mergeLinkedHistory(a,a,received)
  assertEquals("纠正后的原文",result.messages[0].text);assertEquals("page",result.messages[0].sourceId);assertEquals(Speaker.ME,result.messages[0].speaker)
  assertEquals("本人手工修改",result.draft!!.text);assertFalse(ContextEngine.canAct(result));assertTrue(result.memory.entries.isEmpty());assertTrue(result.linkOperations("device").none {it.kind=="message"})
  assertEquals(result,mergeLinkedHistory(result,result,received))
 }
 @Test fun acknowledgementDoesNotChangeRevisionOrInvalidateExistingDraft(){
  val a=archive().copy(draft=ReplyDraft(contextRevision=4,alternatives=listOf("原回复")))
  val result=mergeLinkedHistory(a,a,a.desktop!!.copy(cursor=2));assertEquals(a.revision,result.revision);assertEquals(a.messages,result.messages);assertTrue(ContextEngine.canAct(result))
 }
 @Test fun concurrentPhoneEditKeepsOldVersionForAnExplicitConflict(){
  val a=archive();val latest=ContextEngine.revise(a,listOf(a.messages[0].copy(text="手机编辑")))
  val pc=a.messages[0].copy(text="电脑编辑")
  val result=mergeLinkedHistory(a,latest,a.desktop!!.copy(cursor=3,records=records(a,row(pc,2))))
  assertEquals("手机编辑",result.messages[0].text);assertEquals(1L,result.linkOperations("device").single().expectedVersion)
  val conflict=LinkConflict("phone:device:one",result.linkOperations("device").single(),row(pc,2))
  val waiting=mergeLinkedHistory(result,result,result.desktop!!.copy(conflicts=listOf(conflict)))
  assertTrue(waiting.linkOperations("device").isEmpty());assertEquals("手机编辑",waiting.messages[0].text)
  val resolved=mergeLinkedHistory(waiting,waiting,waiting.desktop!!.copy(conflicts=emptyList(),records=records(waiting,row(pc,3,resolved=true))))
  assertEquals("电脑编辑",resolved.messages[0].text);assertTrue(resolved.linkOperations("device").isEmpty())
 }
 @Test fun editDuringOutgoingAcknowledgementCanContinueFromAcceptedVersion(){
  val a=archive();val outgoing=a.copy(messages=listOf(a.messages[0].copy(text="已上传修改")))
  val latest=ContextEngine.revise(outgoing,listOf(outgoing.messages[0].copy(text="发送期间又修改")))
  val result=mergeLinkedHistory(outgoing,latest,a.desktop!!.copy(records=records(a,row(outgoing.messages[0],2))))
  assertEquals("发送期间又修改",result.messages[0].text);assertEquals(2L,result.linkOperations("device").single().expectedVersion)
 }
 @Test fun ownerCleanupPurgesOldChatAndDraftsButPreservesNewConcurrentCapture(){
  val a=archive().copy(draft=ReplyDraft(contextRevision=4,alternatives=listOf("旧草稿")),historyUndo=archive().messages)
  val new=ChatMessage(id="new",speaker=Speaker.OTHER,text="清理后新记录",sourceId="new-page")
  val latest=ContextEngine.revise(a,a.messages+new)
  val received=a.desktop!!.copy(cursor=4,resetRevision=4,records=records(a,row(a.messages[0],2,deleted=true)))
  val result=mergeLinkedHistory(a,latest,received)
  assertEquals(listOf(new),result.messages);assertNull(result.draft);assertNull(result.historyUndo);assertTrue(result.draftHistory.isEmpty());assertEquals("phone:device:new",result.linkOperations("device").single().id)
 }
 @Test fun interruptedGenerationIsRecoverableAndKeepsItsRewriteRequest(){
  val a=archive().copy(replyAttempt=ReplyAttempt("generation","简短一点"),draft=ReplyDraft(contextRevision=4,alternatives=listOf("旧候选"),text="手工稿",manuallyEdited=true))
  val restored=a.recoverReplyAttempt();assertEquals("interrupted",restored.replyAttempt!!.phase);assertEquals("简短一点",restored.replyAttempt!!.instruction);assertEquals("手工稿",restored.draft!!.text)
  assertEquals(restored,restored.recoverReplyAttempt());val completed=a.copy(replyAttempt=ReplyAttempt("completed"));assertEquals(completed,completed.recoverReplyAttempt())
 }
}
