package cn.replyassistant.domain

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class MobileReplyFlowTest {
    @Test fun switchingCandidatesRetainsEachEditAndSurvivesStorage() {
        var draft = ReplyDraft(contextRevision = 0, alternatives = listOf("原文一", "原文二", "原文三"),
            text = "改过的一", manuallyEdited = true, alternativeLabels = listOf("简短接话", "继续聊", "问清楚"))
        draft = draft.selectAlternative(1).copy(text = "改过的二", manuallyEdited = true)
        draft = draft.selectAlternative(0)
        assertEquals("改过的一", draft.text)
        assertTrue(draft.manuallyEdited)
        draft = Json.decodeFromString<ReplyDraft>(Json.encodeToString(draft)).selectAlternative(1)
        assertEquals("改过的二", draft.text)
        assertEquals("继续聊", draft.alternativeLabels[1])
        assertEquals("原文三", draft.selectAlternative(2).text)
        assertFalse(draft.selectAlternative(2).manuallyEdited)
    }

    @Test fun topicExamplesIncludeRelevantOlderSpeechAndExcludeAiAndUncertainSources() {
        val older = listOf(ChatMessage(speaker = Speaker.OTHER, text = "周末去喝咖啡吗"),
            ChatMessage(speaker = Speaker.ME, text = "行呀，老地方见"))
        val recent = (1..12).flatMap { listOf(ChatMessage(speaker = Speaker.OTHER, text = "今天上班怎么样$it"),
            ChatMessage(speaker = Speaker.ME, text = "还行$it")) }
        val excluded = listOf(ChatMessage(speaker = Speaker.OTHER, text = "周末喝咖啡", orderUncertain = true),
            ChatMessage(speaker = Speaker.ME, text = "顺序不确定的样例"),
            ChatMessage(speaker = Speaker.OTHER, text = "喝咖啡吗"),
            ChatMessage(speaker = Speaker.ME, text = "AI喝咖啡样例", generated = true))
        val prompt = Personalization.prompt(ChatArchive(name = "A", messages = older + recent + excluded), "周末喝咖啡", 4)
        assertTrue(prompt.contains("老地方见"))
        assertFalse(prompt.contains("顺序不确定的样例"))
        assertFalse(prompt.contains("AI喝咖啡样例"))
        assertEquals(4, prompt.split(" → 本人：").size - 1)
    }

    @Test fun generationPromptRequestsDistinctStrategiesAndHonorsManualRewrite() {
        val archive = ChatArchive(name = "A", messages = listOf(ChatMessage(speaker = Speaker.OTHER, text = "周末一起走走吗")))
        val prompt = ContextEngine.prompt(archive, "保留我写的前半句", "口语，少用问号")
        assertTrue(prompt.contains("alternativeLabels"))
        assertTrue(prompt.contains("不能只替换同义词"))
        assertTrue(prompt.contains("保留本人手工修改"))
        assertTrue(prompt.contains("保留我写的前半句"))
        assertTrue(prompt.contains("少用问号"))
    }
}
