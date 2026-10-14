package cn.replyassistant.domain

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromJsonElement

@Serializable data class ChannelBackground(val sourceId:String,val channelId:String,val channelLabel:String,val speaker:Speaker,val text:String,val timestamp:Long?)
@Serializable data class ChannelRevision(val id:String,val revision:Long,val personKey:String,val desktopCursor:Long)
object PersonChannels {
 private val json=Json {ignoreUnknownKeys=true}
 fun key(a:ChatArchive):String {
  val c=MobilePipelineV2.linkedContext(a)
  if(a.desktop?.active==true&&c?.personId!=null)return "desktop:${c.ownerId}:${c.personId}"
  return if(a.personId!=null)"local:${a.personId}" else "archive:${a.id}"
 }
 fun related(a:ChatArchive,archives:List<ChatArchive>)=archives.filter {it.id!=a.id&&key(it)==key(a)&&it.enabled}
 fun revisions(a:ChatArchive,archives:List<ChatArchive>)=(listOf(a)+related(a,archives)).map {ChannelRevision(it.id,it.revision,key(it),it.desktop?.cursor?:0)}.sortedBy {it.id}
 fun background(a:ChatArchive,archives:List<ChatArchive>,topic:String):List<ChannelBackground> {
  val linked=MobilePipelineV2.linkedContext(a)
  val remote=if(a.desktop?.active==false||linked?.enabled==false)emptyList() else a.desktop?.records.orEmpty().filter {it.kind=="message"&&!it.deleted&&it.id.startsWith("desktop:person:")}.mapNotNull {r->
   runCatching {val m=json.decodeFromJsonElement<LinkMessage>(r.body!!);if(m.channelContactId==null||linked?.channels?.none {it.contactId==m.channelContactId&&it.shared}!=false||m.uncertain||m.generated||m.speaker==Speaker.UNKNOWN||m.timestamp==null)null else ChannelBackground(m.sourceId,m.channelContactId,m.channelLabel?:"其他渠道",m.speaker,m.text,m.timestamp)}.getOrNull()
  }
  val local=related(a,archives).flatMap {other->val otherContext=MobilePipelineV2.linkedContext(other);other.messages.filter {!it.generated&&!it.uncertain&&!it.orderUncertain&&it.speaker!=Speaker.UNKNOWN&&it.timestamp!=null}.map {ChannelBackground(if(other.desktop?.active==true&&other.desktop.deviceId.isNotBlank())"phone:${other.desktop.deviceId}:${it.id}" else "channel:${other.id}:${it.id}",otherContext?.contactId?:other.id,"${other.name} · ${other.platform}",it.speaker,it.text,it.timestamp)}}
  return (remote+local).distinctBy {it.channelId to it.sourceId}.filter {MobilePipelineV2.score(topic,it.text)>0}.sortedByDescending {MobilePipelineV2.score(topic,it.text)}.take(12)
 }
 fun link(archives:List<ChatArchive>,sourceId:String,targetId:String?):List<ChatArchive> {
  val source=archives.firstOrNull {it.id==sourceId}?:error("聊天渠道不存在")
  val target=targetId?.let {id->archives.firstOrNull {it.id==id}?:error("人物不存在")}
  require(source.desktop?.active!=true&&target?.desktop?.active!=true){"已连接电脑的档案，请在工作台「人物与导入」关联或解除，随后同步"}
  val oldKey=key(source);val targetKey=target?.let(::key);val personId=target?.personId?:target?.id
  return archives.map {a->when {
   a.id==sourceId->a.copy(personId=personId,personName=target?.personName?.ifBlank {target.name}?:target?.name.orEmpty(),revision=a.revision+1,draft=null,lastDecisionV2=null)
   a.id==targetId->a.copy(personId=personId,personName=a.personName.ifBlank {a.name},revision=a.revision+1,draft=null,lastDecisionV2=null)
   key(a)==oldKey||targetKey!=null&&key(a)==targetKey->a.copy(revision=a.revision+1,draft=null,lastDecisionV2=null)
   else->a
  }}
 }
}
