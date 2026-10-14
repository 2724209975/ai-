package cn.replyassistant

import cn.replyassistant.domain.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.encodeToJsonElement
import org.junit.Assert.*
import org.junit.Test

class ChatHistoryTest {
    @Test fun screenshotsStayAfterTimedSentSpeechInSavedOrder(){
        val rows=listOf(ChatMessage(speaker=Speaker.OTHER,text="之前的截图"),ChatMessage(speaker=Speaker.ME,text="实际发出的回复",origin=Origin.CONFIRMED_DRAFT,timestamp=100),ChatMessage(speaker=Speaker.OTHER,text="之后的截图"))
        assertEquals(rows.map {it.id},ChatArchive(name="A",messages=rows).chatHistory().map {it.message.id})
    }
    @Test fun tombstonesPhoneEchoAndDraftsNeverAppearAsSpeech(){
        val m=LinkMessage(Speaker.OTHER,"相同文字",20,false,false,false,"source")
        val record=LinkRecord("desktop:one","message",Json.encodeToJsonElement(m),1,1,false)
        val a=ChatArchive(name="A",messages=listOf(ChatMessage(speaker=Speaker.OTHER,text="相同文字",timestamp=10)),
            draft=ReplyDraft(contextRevision=0,alternatives=listOf("草稿")),desktop=LinkedArchive("group",records=listOf(record,record.copy(id="phone:echo"),record.copy(id="desktop:deleted",deleted=true),record.copy(id="desktop:malformed",body=null))))
        val history=a.chatHistory();assertEquals(2,history.size)
        assertFalse(history.first().desktop);assertTrue(history.last().desktop)
        assertEquals(listOf("相同文字","相同文字"),history.map {it.message.text})
    }
}
