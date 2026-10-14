package cn.replyassistant.domain
import org.junit.Assert.*
import org.junit.Test
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.encodeToJsonElement
class PersonChannelsTest {
 @Test fun linkingPreservesSourcesAndRepeatedSpeechInDifferentChannels() {
  val a=ChatArchive(id="wx",name="同名",platform="微信",messages=listOf(ChatMessage(id="one",speaker=Speaker.OTHER,text="好的",timestamp=1)))
  val b=ChatArchive(id="qq",name="同名",platform="QQ",messages=listOf(ChatMessage(id="two",speaker=Speaker.OTHER,text="好的",timestamp=1)))
  assertNotEquals(PersonChannels.key(a),PersonChannels.key(b));val linked=PersonChannels.link(listOf(a,b),b.id,a.id)
  assertEquals(PersonChannels.key(linked[0]),PersonChannels.key(linked[1]));assertEquals(2,linked[0].personHistory(linked).size)
  val detached=PersonChannels.link(linked,b.id,null);assertNotEquals(PersonChannels.key(detached[0]),PersonChannels.key(detached[1]));assertEquals(1,detached[0].personHistory(detached).size)
  val untimed=a.copy(messages=listOf(ChatMessage(id="z",speaker=Speaker.OTHER,text="第一句"),ChatMessage(id="a",speaker=Speaker.ME,text="第二句")))
  assertEquals(listOf("z","a"),untimed.personHistory(listOf(untimed)).map {it.message.id})
 }
 @Test fun relatedBackgroundNeverBecomesTheCurrentTriggerAndEditsInvalidateCopy() {
  val a=ChatArchive(id="wx",name="冬冬",platform="微信",personId="person",messages=listOf(ChatMessage(id="trigger",speaker=Speaker.OTHER,text="晚上吃面条吗",timestamp=200)))
  val b=ChatArchive(id="qq",name="冬冬",platform="QQ",personId="person",messages=listOf(ChatMessage(id="old",speaker=Speaker.OTHER,text="我喜欢面条",timestamp=100)))
  val c=MobilePipelineV2.build(a,"",archives=listOf(a,b));assertEquals(listOf("trigger"),c.triggerMessageIds);assertEquals(1,c.channelBackground.size);assertEquals("QQ",c.channelBackground[0].channelLabel.substringAfter(" · "))
  assertFalse(c.recentMessages.any {it.id=="old"});assertTrue(MobilePipelineV2.contextCurrent(a,c,archives=listOf(a,b)))
  assertFalse(MobilePipelineV2.contextCurrent(a,c,archives=listOf(a,b.copy(revision=1))));assertFalse(MobilePipelineV2.contextCurrent(a,c,archives=listOf(a)))
  assertEquals(emptyList<ChannelBackground>(),PersonChannels.background(a,listOf(a,b.copy(messages=b.messages.map {it.copy(uncertain=true)})),"面条"))
 }
 @Test fun remoteMembershipLimitsEvidenceAndUnlinkRemovesCachedBackground() {
  val json=Json {encodeDefaults=true};val channel=LinkedChannel("other","person","QQ","qq",accountId="acct",conversationId="conv")
  val context=LinkedContextV2(contactId="current",ownerId="owner",accountId="wx-acct",conversationId="wx-conv",platform="wechat",enabled=true,relationship=LinkedRelationshipV2(),personalStyle=LinkedStyleV2(),personId="person",personVersion=1,channels=listOf(channel))
  val message=LinkMessage(Speaker.OTHER,"喜欢面条",100,false,false,false,"source",channelContactId="other",channelLabel="QQ")
  val records=listOf(LinkRecord("desktop:context-v2","context_v2",json.encodeToJsonElement(context),1,1,false),LinkRecord("desktop:person:source","message",json.encodeToJsonElement(message),1,2,false))
  val a=ChatArchive(name="冬冬",desktop=LinkedArchive("g",records=records));assertEquals(1,PersonChannels.background(a,listOf(a),"面条").size)
  val correlation="phone:device:local-message"
  val correlated=a.copy(desktop=a.desktop!!.copy(records=records.map {if(it.kind=="message")it.copy(body=json.encodeToJsonElement(message.copy(sourceId=correlation)))else it}))
  val other=ChatArchive(name="冬冬QQ",messages=listOf(ChatMessage(id="local-message",speaker=Speaker.OTHER,text="喜欢面条",timestamp=100)),desktop=LinkedArchive("other-group",deviceId="device",records=listOf(records[0].copy(body=json.encodeToJsonElement(context.copy(contactId="other",accountId="acct",conversationId="conv"))))))
  assertEquals(1,PersonChannels.background(correlated,listOf(correlated,other),"面条").size)
  assertEquals(1,correlated.personHistory(listOf(correlated,other)).size)
  val removed=a.copy(desktop=a.desktop!!.copy(records=records.map {if(it.kind=="context_v2")it.copy(body=json.encodeToJsonElement(context.copy(channels=emptyList(),personVersion=2)))else it}));assertEquals(0,PersonChannels.background(removed,listOf(removed),"面条").size)
  assertEquals(0,PersonChannels.background(a.copy(desktop=a.desktop!!.copy(active=false)),listOf(a),"面条").size)
 }
}
