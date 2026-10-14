package cn.replyassistant.domain

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromJsonElement

data class HistoryMessage(val key:String,val message:ChatMessage,val source:String,val desktop:Boolean=false)

/** Only saved speech. Phone copies returned by sync do not duplicate local messages. */
fun ChatArchive.chatHistory():List<HistoryMessage> {
    val json=Json {ignoreUnknownKeys=true}
    val local=messages.map {HistoryMessage("local:${it.id}",it,when(it.origin){
        Origin.SCREENSHOT->"截图识别";Origin.NOTIFICATION->"通知";Origin.ACCESSIBILITY->"当前聊天";Origin.MANUAL->"手动记录";Origin.CONFIRMED_DRAFT->"确认发送"
    })}
    val remote=desktop?.records.orEmpty().filter {!it.deleted&&it.kind=="message"&&it.id.startsWith("desktop:")&&!it.id.startsWith("desktop:person:")}.mapNotNull {record->
        runCatching {val m=json.decodeFromJsonElement<LinkMessage>(record.body!!)
            HistoryMessage(record.id,ChatMessage(id=record.id,speaker=m.speaker,text=m.text,timestamp=m.timestamp,sourceId=m.sourceId,uncertain=m.uncertain,generated=m.generated,styleExample=m.styleExample),"电脑同步",true)
        }.getOrNull()
    }
    // Local order is the saved dialogue order, including untimed screenshots and manual reordering.
    // Never move all untimed screenshots before timed sent messages.
    val orderedRemote=remote.sortedBy {it.message.timestamp?:Long.MIN_VALUE}
    if(local.isEmpty())return orderedRemote
    if(orderedRemote.isEmpty())return local
    val merged=ScreenshotStitcher.merge(local.map {it.message},orderedRemote.map {it.message})
    val byId=(local+orderedRemote).associateBy {it.message.id}
    return merged.messages.mapNotNull {message->byId[message.id]?.copy(message=message)}
}
/** Other channels are displayed separately and never passed through screenshot overlap dedup. */
fun ChatArchive.personHistory(archives:List<ChatArchive>):List<HistoryMessage> {
    val own=chatHistory().map {it.copy(source="$platform · ${it.source}")}
    val json=Json {ignoreUnknownKeys=true}
    val context=MobilePipelineV2.linkedContext(this)
    val shared=desktop?.records.orEmpty().filter {!it.deleted&&it.kind=="message"&&it.id.startsWith("desktop:person:")}.mapNotNull {r->runCatching {
        val m=json.decodeFromJsonElement<LinkMessage>(r.body!!)
        if(context?.channels?.none {it.contactId==m.channelContactId}!=false)null else HistoryMessage("${m.channelContactId}:${m.sourceId}",ChatMessage(id=r.id,speaker=m.speaker,text=m.text,timestamp=m.timestamp,sourceId=m.sourceId,uncertain=m.uncertain,generated=m.generated),m.channelLabel?:"其他渠道",true)
    }.getOrNull()}
    val local=PersonChannels.related(this,archives).flatMap {a->val channel=MobilePipelineV2.linkedContext(a)?.contactId;a.chatHistory().map {row->
        val identity=if(channel!=null&&a.desktop?.active==true){if(row.desktop)"$channel:desktop:person:${row.message.id.substringAfterLast(':')}" else "$channel:phone:${a.desktop.deviceId}:${row.message.id}"}else "${a.id}:${row.key}"
        row.copy(key=identity,source="${a.name} · ${a.platform} · ${row.source}",desktop=true)
    }}
    // Unknown time is not a license to reorder a saved screenshot conversation by UUID.
    return (own+shared+local).distinctBy {it.key}.sortedBy {it.message.timestamp?:Long.MAX_VALUE}
}
