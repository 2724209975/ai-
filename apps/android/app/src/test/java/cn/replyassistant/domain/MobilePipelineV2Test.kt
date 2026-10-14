package cn.replyassistant.domain

import org.junit.Assert.*
import org.junit.Test
import kotlinx.serialization.json.*
import java.time.Instant

class MobilePipelineV2Test {
 private val json=Json {encodeDefaults=true}
 private val now=Instant.parse("2026-10-12T00:00:00Z").toEpochMilli()
 private fun memory(id:String="m",extraStatus:String="active")=LinkedMemoryV2(id,1,"owner","contact","conversation","account","boundary","contact","avoid","地址","不要问地址","user_confirmed",emptyList(),1.0,.9,validFrom="2026-10-01T00:00:00Z",status=extraStatus,observedAt="2026-10-11T00:00:00Z",evidenceValid=true)
 private fun archive(memories:List<LinkedMemoryV2> = listOf(memory()),enabled:Boolean=true):ChatArchive {
  val records=listOf(LinkRecord("desktop:context-v2","context_v2",json.encodeToJsonElement(LinkedContextV2(contactId="contact",ownerId="owner",accountId="account",conversationId="conversation",platform="qq",enabled=enabled,relationship=LinkedRelationshipV2(),personalStyle=LinkedStyleV2())),1,1,false))+
   memories.mapIndexed {i,m->LinkRecord("desktop:memory:${m.id}","memory_v2",json.encodeToJsonElement(m),1,i+2L,false)}
  return ChatArchive(name="合成",messages=listOf(ChatMessage(id="incoming",speaker=Speaker.OTHER,text="今天怎么样")),desktop=LinkedArchive("group",records=records))
 }
 private fun decision(c:MobileContextV2)=MobileDecisionV2("2.0","reply","回应",MobileEmotionV2("neutral",.9),null,"接话","自然","short","low",emptyList(),c.triggerMessageIds,"NORMAL_REPLY",false)
 @Test fun onlyScopedConfirmedCurrentEvidenceSurvivesOffline() {
  val good=memory();val a=archive(listOf(good,memory("pending","pending"),memory("deleted","deleted"),memory("expired").copy(validUntil="2026-10-11T00:00:00Z"),memory("other").copy(contactId="other"),memory("other-account").copy(accountId="another"),memory("other-owner").copy(ownerId="another"),memory("stale").copy(evidenceValid=false),memory("inferred").copy(evidenceType="inferred"),memory("old").copy(observedAt="2025-01-01T00:00:00Z")))
  assertEquals(listOf(good),MobilePipelineV2.effectiveMemories(a,now))
  assertEquals(emptyList<LinkedMemoryV2>(),MobilePipelineV2.effectiveMemories(archive(enabled=false),now))
  assertTrue(MobilePipelineV2.render(MobilePipelineV2.build(a,"",now)).contains("不要问地址"))
 }
 @Test fun protectedBoundaryAndAllTriggerMessagesSurviveBudgetAndOversizeFails() {
  val a=archive().copy(messages=(1..44).map {ChatMessage(id="old$it",speaker=Speaker.ME,text="旧资料".repeat(300))}+ (1..3).map {ChatMessage(id="trigger$it",speaker=Speaker.OTHER,text="当前问题$it")})
  val c=MobilePipelineV2.build(a,"",now,512)
  assertEquals(3,c.triggerMessageIds.size);assertEquals(listOf("m"),c.memories.map {it.id});assertTrue(c.estimatedInputTokens<=512)
  assertNotNull(runCatching {MobilePipelineV2.build(archive(listOf(memory().copy(content="明确边界".repeat(3000)))),"",now,512)}.exceptionOrNull())
 }
 @Test fun localRulesNeverDowngradeRiskOrInventRequiredFacts() {
  val c=MobilePipelineV2.build(archive().copy(messages=listOf(ChatMessage(id="incoming",speaker=Speaker.OTHER,text="你根本不理我，我很难过"))),"",now)
  val d=MobilePipelineV2.enforce(decision(c),c);assertEquals("high",d.risk_level);assertTrue(d.needs_user_approval)
  assertEquals("ask_user",MobilePipelineV2.enforce(d.copy(required_memory_keys=listOf("birthday")),c).action)
  for((text,action) in listOf("等一下" to "wait","不要再联系我" to "skip")) {
   val next=c.copy(recentMessages=listOf(ChatMessage(id="incoming",speaker=Speaker.OTHER,text=text)))
   assertEquals(action,MobilePipelineV2.enforce(decision(next),next).action)
  }
  assertNotNull(runCatching {MobilePipelineV2.enforce(d.copy(evidence_message_ids=listOf("invented")),c)}.exceptionOrNull())
  assertEquals("ask_user",MobilePipelineV2.enforce(d,c.copy(recentMessages=c.recentMessages.map {it.copy(uncertain=true)})).action)
 }
 @Test fun explicitStyleIsAppliedBeforeChecksAndBoundaryRemainsProtected() {
  val c=MobilePipelineV2.build(archive(),"",now).copy(personalStyle=LinkedStyleV2(settings=mapOf("emoji" to JsonPrimitive("none"),"punctuation" to JsonPrimitive("none"),"avoid" to buildJsonArray {add(JsonPrimitive("亲爱的"))})))
  assertEquals("好呀",MobilePipelineV2.renderStyle(c,"好呀🙂。"))
  assertEquals("review_required",MobilePipelineV2.quality(c,decision(c),"亲爱的，聊聊吧").status)
  assertEquals("blocked",MobilePipelineV2.quality(c,decision(c),"你住哪里呀").status)
 }
 @Test fun editsCannotBypassChecksAndDeletedOrExpiredMemoryInvalidatesCopy() {
  val m=memory().copy(validUntil=Instant.ofEpochMilli(now+60000).toString());val a=archive(listOf(m));val c=MobilePipelineV2.build(a,"",now);val d=decision(c)
  assertTrue(MobilePipelineV2.contextCurrent(a,c,now));assertFalse(MobilePipelineV2.contextCurrent(a,c,now+60001))
  assertFalse(MobilePipelineV2.contextCurrent(archive(listOf(m.copy(status="deleted"))),c,now))
  assertEquals("blocked",MobilePipelineV2.quality(c,d,"我毕业于北京大学").status)
  assertEquals("blocked",MobilePipelineV2.quality(c,d,"我给你转账").status)
  val withDraft=a.copy(draft=ReplyDraft(contextRevision=a.revision,alternatives=listOf("好呀","聊一会吧","你呢"),contextV2=c.copy(memories=emptyList()),decisionV2=d))
  assertTrue(ContextEngine.canAct(withDraft));assertFalse(ContextEngine.canAct(withDraft.copy(draft=withDraft.draft!!.copy(text="我给你转账"))))
 }
}
