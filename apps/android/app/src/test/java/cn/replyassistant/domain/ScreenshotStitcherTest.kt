package cn.replyassistant.domain

import org.junit.Assert.*
import org.junit.Test

class ScreenshotStitcherTest {
    private fun rows(source:String)=listOf(
        ChatMessage(speaker=Speaker.OTHER,text="周末一起去喝咖啡吗",origin=Origin.SCREENSHOT,sourceId=source),
        ChatMessage(speaker=Speaker.ME,text="我周日下午可以",origin=Origin.SCREENSHOT,sourceId=source),
        ChatMessage(speaker=Speaker.OTHER,text="那我们两点见",origin=Origin.SCREENSHOT,sourceId=source))
    @Test fun containedScreenshotReusesOriginalIdsInsteadOfAppendingItAgain(){
        val old=rows("first");val fresh=rows("second").take(2)
        val result=ScreenshotStitcher.merge(old,fresh)
        assertEquals(old.map {it.id},result.messages.map {it.id});assertTrue(result.newTail.isEmpty())
        assertTrue("second" in result.messages.first().sourceRefs)
        assertTrue(fresh.first().id in result.messages.first().sourceRefs)
    }
    @Test fun pagePictureNoteDoesNotBreakOverlapOrProduceAnotherDuplicateNote(){
        val note=ChatMessage(speaker=Speaker.UNKNOWN,text="[图片内容，发言归属不确定] 一张图片",uncertain=true,origin=Origin.SCREENSHOT,sourceId="first")
        val old=rows("first")+note
        val fresh=rows("second")+note.copy(id=newId(),sourceId="second")
        val result=ScreenshotStitcher.merge(old,fresh)
        assertEquals(4,result.messages.size);assertEquals(note.id,result.messages.last().id)
        assertTrue(result.messages.last().uncertain)
    }
    @Test fun olderScreenshotIsPlacedBeforeTheUniqueKnownWindow(){
        val old=rows("first")
        val intro=ChatMessage(speaker=Speaker.ME,text="前一天说过的背景",origin=Origin.SCREENSHOT,sourceId="older")
        val result=ScreenshotStitcher.merge(old,listOf(intro)+rows("older"))
        assertEquals(listOf(intro.id)+old.map {it.id},result.messages.map {it.id})
    }
    @Test fun newTailFollowsKnownMessagesAndDoesNotDiscardRepeatedAcknowledgements(){
        val old=rows("first")
        val fresh=rows("second").drop(1)+ChatMessage(speaker=Speaker.ME,text="好的我到时联系你",origin=Origin.SCREENSHOT,sourceId="second")
        val result=ScreenshotStitcher.merge(old,fresh)
        assertEquals(4,result.messages.size);assertEquals("好的我到时联系你",result.newTail.single().text)
        val ack=ChatMessage(speaker=Speaker.ME,text="好",origin=Origin.SCREENSHOT,sourceId="one")
        assertEquals(2,ScreenshotStitcher.merge(listOf(ack),listOf(ack.copy(id=newId(),sourceId="two"))).messages.size)
    }
    @Test fun ambiguousAndDifferentlyTimedExchangesArePreserved(){
        val first=rows("one").take(2)
        val repeated=first+ChatMessage(speaker=Speaker.OTHER,text="中间的新话题",origin=Origin.SCREENSHOT)+rows("two").take(2)
        val result=ScreenshotStitcher.merge(repeated,rows("three").take(2))
        assertEquals(7,result.messages.size);assertTrue(result.messages.takeLast(2).all {it.orderUncertain})
        val timed=first.map {it.copy(timestamp=100)}
        assertEquals(4,ScreenshotStitcher.merge(timed,rows("later").take(2).map {it.copy(timestamp=200)}).messages.size)
    }
    @Test fun legacyRepairUsesCaptureBatchesAndIsRepeatable(){
        val old=rows("one")+rows("two")+rows("three").take(2)
        val repaired=ScreenshotStitcher.repair(old)
        assertEquals(3,repaired.size);assertEquals(rows("x").map {it.text},repaired.map {it.text})
        assertEquals(repaired,ScreenshotStitcher.repair(repaired))
    }
    @Test fun provenanceOnlyChangeDoesNotEraseFactMemoryOrReplaceManualDraft(){
        val messages=rows("one")
        val draft=ReplyDraft(contextRevision=0,alternatives=listOf("手工稿"),manuallyEdited=true)
        val original=ChatArchive(name="甲",messages=messages,draft=draft,memory=RelationshipMemory(consent=true,entries=listOf(MemoryEntry(kind="fact",text="有来源的事实",sourceIds=listOf(messages.first().id)))))
        val updated=ContextEngine.append(original,rows("two"))
        assertEquals(draft,updated.draft)
        assertEquals(original.memory.entries,Personalization.invalidateMemory(original,updated.messages).entries)
    }
}
