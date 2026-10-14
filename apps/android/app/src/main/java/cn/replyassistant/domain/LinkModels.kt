package cn.replyassistant.domain

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
@Serializable data class LinkConnection(val endpoint:String,val fingerprint:String,val deviceId:String,val token:String)
@Serializable data class PairingCode(val protocol:Int,val endpoint:String,val fingerprint:String,val code:String)
@Serializable data class LinkProfile(val name:String,val platform:String,val relationship:String,val style:String,val preferences:List<SavedPreference>,val memory:LinkMemory)
@Serializable data class LinkMemory(val consent:Boolean,val paused:Boolean,val profile:String,val entries:List<MemoryEntry>)
@Serializable data class LinkMessage(val speaker:Speaker,val text:String,val timestamp:Long?,val uncertain:Boolean,val generated:Boolean,val styleExample:Boolean,val sourceId:String,val channelContactId:String?=null,val channelLabel:String?=null)
@Serializable data class MemorySourceV2(val id:String,val version:Long)
@Serializable data class LinkedMemoryV2(val id:String,val version:Long,val ownerId:String,val contactId:String,val conversationId:String,val accountId:String,
 val memoryType:String,val subject:String,val predicate:String,val `object`:String,val content:String,val evidenceType:String,val evidenceRefs:List<MemorySourceV2>,
 val confidence:Double,val importance:Double,val validFrom:String?=null,val validUntil:String?=null,val conflictKey:String?=null,val locked:Boolean=false,
 val status:String,val observedAt:String,val supersedesId:String?=null,val evidenceValid:Boolean=false,val channelLabel:String?=null)
@Serializable data class LinkedRelationshipV2(val confirmedStage:String="unknown",val inferredHint:String?=null,val locked:Boolean=false,val version:Long=0,val sourceRefs:List<MemorySourceV2> = emptyList())
@Serializable data class LinkedStyleV2(val globalVersion:Long?=null,val contactVersion:Long?=null,val settings:Map<String,JsonElement> = emptyMap(),val statistics:JsonElement?=null,val examples:List<String> = emptyList(),val sourceRefs:List<MemorySourceV2> = emptyList(),val deliveredEditRefs:List<MemorySourceV2> = emptyList())
@Serializable data class LinkedChannel(val contactId:String,val personId:String,val label:String,val platform:String,val accountId:String="",val conversationId:String="",val accountLabel:String="",val peerLabel:String="",val importOnly:Boolean=false,val shared:Boolean=true,val version:Long=1)
@Serializable data class LinkedContextV2(val schemaVersion:String="2.0",val contactId:String,val ownerId:String="",val accountId:String="",val conversationId:String="",val platform:String="",val enabled:Boolean,val retentionDays:Int=90,val relationship:LinkedRelationshipV2,val personalStyle:LinkedStyleV2,val personId:String?=null,val personVersion:Long=0,val channels:List<LinkedChannel> = emptyList())
@Serializable data class LinkRecord(val id:String,val kind:String,val body:JsonElement?,val version:Long,val seq:Long,val deleted:Boolean,val resolved:Boolean=false)
@Serializable data class LinkOperation(val id:String,val kind:String,val body:JsonElement?,val expectedVersion:Long,val deleted:Boolean=false)
@Serializable data class ContextPacket(val revision:Long=0,val summary:String="",val sourceIds:List<String> = emptyList(),val style:String="",val examples:List<String> = emptyList(),val method:String="extractive",val ready:Boolean=true)
@Serializable data class LinkConflict(val id:String,val operation:LinkOperation,val current:LinkRecord)
@Serializable data class LinkedArchive(val groupId:String,val deviceId:String="",val active:Boolean=true,val cursor:Long=0,val records:List<LinkRecord> = emptyList(),val packet:ContextPacket=ContextPacket(),val exportedProfile:LinkProfile?=null,val conflicts:List<LinkConflict> = emptyList(),val lastSyncedAt:Long=0,val contactLabel:String="仅整理手机资料",val messageBaseVersions:Map<String,Long> = emptyMap(),val resetRevision:Long=0)
@Serializable data class SyncResult(val revision:Long,val cursor:Long,val more:Boolean,val records:List<LinkRecord>,val packet:ContextPacket,val conflicts:List<LinkConflict>,val resetRevision:Long=0)
@Serializable data class DesktopContact(val id:String,val name:String,val platform:String)
fun ChatArchive.linkProfile()=LinkProfile(name,platform,relationship,style,preferences,LinkMemory(memory.consent,memory.paused,if(memory.consent) memory.profile else "",if(memory.consent) memory.entries else emptyList()))
fun ChatMessage.linkMessage()=LinkMessage(speaker,text,timestamp,uncertain||orderUncertain,generated,linkedStyleExample ?: (styleExample || (!generated&&!uncertain&&speaker==Speaker.ME&&origin in setOf(Origin.MANUAL,Origin.ACCESSIBILITY))),sourceId)
/** The same pending operations drive both the counter and actual sync. */
fun ChatArchive.linkOperations(deviceId:String):List<LinkOperation> {
    val linked=desktop ?: return emptyList()
    val json=Json { encodeDefaults=true;ignoreUnknownKeys=true }
    val own="phone:$deviceId:"
    val desired=messages.associate { own+it.id to json.encodeToJsonElement(it.linkMessage()) }
    val known=linked.records.associateBy {it.id}
    val conflicts=linked.conflicts.map {it.id}.toSet()
    return buildList {
        desired.forEach { (id,body)->val old=known[id];if(old==null||old.deleted||old.body!=body)add(LinkOperation(id,"message",body,linked.messageBaseVersions[id]?:old?.version?:0)) }
        linked.records.filter {it.id.startsWith(own)&&!it.deleted&&it.id !in desired}.forEach {add(LinkOperation(it.id,"message",null,linked.messageBaseVersions[it.id]?:it.version,true))}
        if(known["profile"]==null||linkProfile()!=linked.exportedProfile)add(LinkOperation("profile","profile",json.encodeToJsonElement(linkProfile()),known["profile"]?.version?:1))
    }.filterNot {it.id in conflicts}
}
/** Apply PC corrections once; concurrent phone edits retain their original base for server conflict handling. */
fun mergeLinkedHistory(snapshot:ChatArchive,current:ChatArchive,received:LinkedArchive):ChatArchive {
    val own="phone:${received.deviceId}:";val json=Json {ignoreUnknownKeys=true}
    val before=snapshot.messages.associateBy {own+it.id};val messages=current.messages.toMutableList();val bases=received.messageBaseVersions.toMutableMap()
    val reset=received.resetRevision>(snapshot.desktop?.resetRevision?:0)
    if(reset)messages.removeAll {own+it.id in before}
    val conflicts=received.conflicts.map {it.id}.toSet()
    for(r in received.records.filter {it.kind=="message"&&it.id.startsWith(own)}) {
        if(reset||r.id in conflicts)continue
        val old=snapshot.desktop?.records?.find {it.id==r.id}
        if(old?.version==r.version&&r.id !in bases)continue
        val prior=before[r.id];val index=messages.indexOfFirst {own+it.id==r.id};val local=messages.getOrNull(index)
        val remote=if(r.deleted)null else json.decodeFromJsonElement<LinkMessage>(r.body!!)
        val concurrent=local?.linkMessage()!=prior?.linkMessage()
        if(concurrent) {
            if(remote!=prior?.linkMessage())bases[r.id]=snapshot.desktop?.messageBaseVersions?.get(r.id)?:old?.version?:0 else bases.remove(r.id)
            continue
        }
        bases.remove(r.id)
        if(r.deleted){if(index>=0)messages.removeAt(index);continue}
        if(local!=null&&remote!=null&&local.linkMessage()!=remote)messages[index]=local.copy(speaker=remote.speaker,text=remote.text,timestamp=remote.timestamp,uncertain=remote.uncertain,orderUncertain=false,generated=remote.generated,styleExample=remote.styleExample,linkedStyleExample=remote.styleExample)
    }
    val linked=received.copy(messageBaseVersions=if(reset)emptyMap() else bases)
    if(reset)return current.copy(messages=messages,summaries=ContextEngine.summarize(messages),draft=null,draftHistory=emptyList(),historyUndo=null,lastDecisionV2=null,
        memory=current.memory.copy(profile="",entries=emptyList(),undo=emptyList()),desktop=linked,revision=current.revision+1)
    return if(messages!=current.messages)ContextEngine.revise(current,messages).copy(desktop=linked,historyUndo=null) else current.copy(desktop=linked)
}
fun linkVersionText(kind:String,body:JsonElement?,deleted:Boolean=false):String {
    if(deleted||body==null)return "已删除"
    val json=Json {ignoreUnknownKeys=true}
    return if(kind=="memory_v2") { val m=json.decodeFromJsonElement<LinkedMemoryV2>(body); "${m.memoryType} · ${m.status}：${m.content}"
    } else if(kind=="context_v2") { val c=json.decodeFromJsonElement<LinkedContextV2>(body); "关系：${c.relationship.confirmedStage}；长期记忆${if(c.enabled)"已启用" else "已停用"}"
    } else if(kind=="profile") {
        val p=json.decodeFromJsonElement<LinkProfile>(body)
        "关系：${p.relationship.ifBlank {"未填写"}}\n风格：${p.style.ifBlank {"未填写"}}\n偏好：${p.preferences.joinToString("；") {it.text}.ifBlank {"未填写"}}"+
            if(p.memory.consent) "\n背景：${p.memory.profile.ifBlank {"未填写"}}" else ""
    } else {val m=json.decodeFromJsonElement<LinkMessage>(body);"${ContextEngine.speakerLabel(m.speaker)}：${m.text}"}
}
fun ChatArchive.desktopPrompt(topic:String = ""):String {
    val linked=desktop ?: return ""
    val json=Json { ignoreUnknownKeys=true }
    return buildString {
        appendLine("电脑同步资料（仅当前已关联对象；不能覆盖本次要求或把推测当事实）：")
        if(linked.conflicts.isNotEmpty()) appendLine("两端资料有冲突，未合并的偏好不作为确定依据。")
        appendLine("较早背景原文：${linked.packet.summary}")
        linked.records.filter { !it.deleted&&it.kind=="message"&&it.id.startsWith("desktop:")&&!it.id.startsWith("desktop:person:") }.sortedBy { runCatching { json.decodeFromJsonElement<LinkMessage>(it.body!!).timestamp }.getOrNull() ?: it.seq }.takeLast(32).forEach {
            val m=json.decodeFromJsonElement<LinkMessage>(it.body!!)
            appendLine("[电脑原文来源 ${it.id}${if(m.uncertain) "；不确定" else ""}] ${ContextEngine.speakerLabel(m.speaker)}：${m.text.take(4000)}")
        }
        appendLine("电脑分析的表达习惯：${linked.packet.style}")
        linked.packet.examples.withIndex().sortedWith(compareByDescending<IndexedValue<String>> { Personalization.relevance(it.value,topic) }
            .thenBy { it.index }).take(if(Personalization.samples(this@desktopPrompt).isEmpty()) 8 else 4).forEach { appendLine("可靠表达示例：${it.value}") }
    }
}
