package cn.replyassistant.domain

import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class PersonalizationTest {
    @Test fun modelInterpretedVisibleChatRequiresExplicitStyleSampleMark() {
        val row=ChatMessage(speaker=Speaker.ME,text="模型整理的可见发言",origin=Origin.ACCESSIBILITY)
        assertTrue(Personalization.samples(ChatArchive(name="A",messages=listOf(row))).isEmpty())
        assertEquals(1,Personalization.samples(ChatArchive(name="A",messages=listOf(row.copy(styleExample=true)))).size)
        assertTrue(Personalization.samples(ChatArchive(name="A",messages=listOf(row.copy(styleExample=true,orderUncertain=true)))).isEmpty())
    }
    @Test fun screenshotSamplesRequireExplicitTeachingAndAiNeverQualifies() {
        val screenshot = ChatMessage(speaker = Speaker.ME,text = "行呀",origin = Origin.SCREENSHOT)
        val ai = screenshot.copy(id = newId(),generated = true,styleExample = true)
        val uncertain = screenshot.copy(id = newId(),uncertain = true,styleExample = true)
        assertTrue(Personalization.samples(ChatArchive(name = "A",messages = listOf(screenshot,ai,uncertain))).isEmpty())
        assertEquals(1,Personalization.samples(ChatArchive(name = "A",messages = listOf(screenshot.copy(styleExample = true),ai))).size)
    }
    @Test fun statisticsNeedTenSamplesAndPairedExamplesAreLimitedToEight() {
        val rows = (1..12).flatMap { listOf(ChatMessage(speaker = Speaker.OTHER,text = "问题$it"),ChatMessage(speaker = Speaker.ME,text = "哈哈，好呀$it")) }
        val prompt = Personalization.prompt(ChatArchive(name = "A",messages = rows))
        assertTrue(prompt.contains("平均约")); assertTrue(prompt.contains("常用表达：哈哈、呀"))
        assertEquals(8,prompt.split(" → 本人：").size - 1)
        assertFalse(Personalization.prompt(ChatArchive(name = "A",messages = rows.take(18))).contains("平均约"))
    }
    @Test fun sourceCorrectionsInvalidateMemoryAndUndoCannotRestoreStaleFacts() {
        val row = ChatMessage(speaker = Speaker.OTHER,text = "三点见",sourceId = "page")
        val memory = MemoryEntry(kind = "fact",text = "三点见",sourceIds = listOf("page"))
        val archive = ChatArchive(name = "A",messages = listOf(row),memory = RelationshipMemory(consent = true,entries = listOf(memory),undo = listOf(listOf(memory))))
        val revised = ContextEngine.revise(archive,listOf(row.copy(text = "四点见")))
        assertTrue(revised.memory.entries.isEmpty()); assertTrue(revised.memory.undo.single().isEmpty())
    }
    @Test fun memoryRequiresConsentAndFactCannotUseUserReportOrInventedEvidence() {
        val proposed = listOf(MemorySuggestion("fact","见面",listOf("report")),MemorySuggestion("fact","虚构",listOf("unknown")),
            MemorySuggestion("user_report","本人说周末有空",listOf("report")),MemorySuggestion("fact","对方邀请",listOf("message")))
        val archive = ChatArchive(name = "A")
        assertTrue(Personalization.applyMemory(archive,proposed,setOf("message"),setOf("report")).memory.entries.isEmpty())
        val remembered = Personalization.applyMemory(archive.copy(memory = RelationshipMemory(consent = true)),proposed,setOf("message"),setOf("report"))
        assertEquals(listOf("user_report","fact"),remembered.memory.entries.map { it.kind })
        assertEquals(remembered,Personalization.applyMemory(remembered,proposed,setOf("message"),setOf("report")))
        val paused = archive.copy(memory = RelationshipMemory(consent = true,paused = true))
        assertEquals(paused,Personalization.applyMemory(paused,proposed,setOf("message"),setOf("report")))
    }
    @Test fun legacyArchivesUpgradeWithDisabledSkillAndNoConsent() {
        val old = Json.decodeFromString<ChatArchive>("""{"name":"旧对象"}""")
        assertFalse(old.skill.enabled); assertFalse(old.memory.consent); assertTrue(old.consultation.turns.isEmpty())
    }
    @Test fun draftHistoryKeepsEditsWithoutCountingThemAsSpeech() {
        val edited = ReplyDraft(contextRevision = 1,alternatives = listOf("AI"),text = "手工改稿",manuallyEdited = true)
        val a = ChatArchive(name = "A",draft = edited)
        val history = Personalization.rememberDraft(a)
        assertEquals(listOf(edited.text),history.map { it.text })
        assertEquals(history,Personalization.rememberDraft(a.copy(draftHistory = history)))
        assertTrue(a.messages.isEmpty()); assertTrue(Personalization.samples(a).isEmpty())
    }

    @Test fun appearanceChangesDoNotInvalidateRequestsButSpeedChangesDo() {
        val settings = ModelSettings()
        assertTrue(settings.sameReplyConfiguration(settings.copy(bubbleOpacity = .3f,panelOpacity = .6f)))
        assertFalse(settings.sameReplyConfiguration(settings.copy(fastReplies = false)))
    }
}
