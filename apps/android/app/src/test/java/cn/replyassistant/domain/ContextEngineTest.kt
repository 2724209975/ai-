package cn.replyassistant.domain

import org.junit.Assert.*
import org.junit.Test

class ContextEngineTest {
    private fun row(text: String, who: Speaker = Speaker.OTHER, time: Long? = null) = ChatMessage(speaker = who, text = text, timestamp = time)
    @Test fun `overlapping pages preserve ordered dialogue and append the tail`() {
        val first = listOf(row("周末有空吗"), row("周日下午可以", Speaker.ME), row("那一起喝咖啡"))
        val second = listOf(row("周日下午可以", Speaker.ME), row("那一起喝咖啡"), row("几点呢", Speaker.ME))
        val archive = ContextEngine.append(ContextEngine.append(ChatArchive(name = "甲"), first), second)
        assertEquals(4, archive.messages.size)
        assertEquals("几点呢", archive.messages.last().text)
    }
    @Test fun `one untimed repeated acknowledgement must not be discarded`() {
        assertEquals(0, ContextEngine.overlap(listOf(row("好")), listOf(row("好"))))
    }
    @Test fun `a repeated same phrase sequence is ambiguous`() {
        assertEquals(0, ContextEngine.overlap(listOf(row("好"), row("好")), listOf(row("好"), row("好"))))
    }
    @Test fun `single message with matching time can overlap`() {
        assertEquals(1, ContextEngine.overlap(listOf(row("好", time = 123)), listOf(row("好", time = 123))))
    }
    @Test fun `different senders or timestamps do not identify the same message`() {
        assertEquals(0, ContextEngine.overlap(listOf(row("好", time = 1)), listOf(row("好", Speaker.ME, 1))))
        assertEquals(0, ContextEngine.overlap(listOf(row("好", time = 1)), listOf(row("好", time = 2))))
    }
    @Test fun `different order does not overlap`() {
        assertEquals(0, ContextEngine.overlap(listOf(row("一"), row("二", Speaker.ME)), listOf(row("二", Speaker.ME), row("一"))))
    }
    @Test fun `unknown speakers require confirmation`() {
        val exception = runCatching { ContextEngine.append(ChatArchive(name = "甲"), listOf(row("你好", Speaker.UNKNOWN))) }.exceptionOrNull()
        assertTrue(exception is IllegalArgumentException)
    }
    @Test fun `editing or deleting originals replaces derived summaries and stales draft`() {
        val messages = (1..50).map { row("原文$it") }
        val archive = ContextEngine.append(ChatArchive(name = "甲"), messages).let {
            it.copy(draft = ReplyDraft(contextRevision = it.revision, alternatives = listOf("建议")))
        }
        val corrected = ContextEngine.revise(archive, archive.messages.drop(1).mapIndexed { i, row -> if (i == 0) row.copy(text = "修正内容") else row })
        assertFalse(ContextEngine.canAct(corrected))
        assertEquals("建议", corrected.draft!!.text)
        assertFalse(corrected.summaries.flatMap { it.sourceIds }.contains(messages[0].id))
        assertTrue(corrected.summaries.first().text.contains("修正内容"))
    }
    @Test fun `draft copy and fill do not enter history or summaries`() {
        val archive = ContextEngine.append(ChatArchive(name = "甲"), listOf(row("你好")))
        for (state in listOf(DraftState.EDITING, DraftState.COPIED, DraftState.FILLED)) {
            val withDraft = archive.copy(draft = ReplyDraft(contextRevision = archive.revision, alternatives = listOf("尚未发送的秘密建议"), state = state))
            assertFalse(ContextEngine.prompt(withDraft, "", "").contains("尚未发送的秘密建议"))
            assertEquals(1, withDraft.messages.size)
        }
    }
    @Test fun `acknowledging a send twice records exactly one actual message`() {
        val archive = ChatArchive(name = "甲", draft = ReplyDraft(contextRevision = 0, alternatives = listOf("确认过的回复")))
        val sent = ContextEngine.markSent(archive)
        val twice = ContextEngine.markSent(sent)
        assertEquals(1, twice.messages.size)
        assertEquals(DraftState.SENT, twice.draft!!.state)
        assertFalse(twice.pending)
    }
    @Test fun `sent generated content is not a personal style example`() {
        val archive = ChatArchive(name = "甲", draft = ReplyDraft(contextRevision = 0, alternatives = listOf("AI生成")))
        val sent = ContextEngine.markSent(archive)
        val prompt = ContextEngine.prompt(sent, "", "")
        assertTrue(prompt.contains("我：AI生成"))
        assertFalse(prompt.contains("本人真实表达示例"))
    }
    @Test fun `new inbound content leaves an old send pending for the next turn`() {
        val archive = ChatArchive(name = "甲", draft = ReplyDraft(contextRevision = 0, alternatives = listOf("回复"), state = DraftState.SUBMITTED))
        val updated = ContextEngine.append(archive, listOf(row("还有件事")))
        assertTrue(ContextEngine.markSent(updated).pending)
    }
    @Test fun `unresolved or completed send cannot be reissued`() {
        for (status in listOf(DraftState.SUBMITTING, DraftState.SUBMITTED, DraftState.UNKNOWN, DraftState.SENT)) {
            val archive = ChatArchive(name = "甲", draft = ReplyDraft(contextRevision = 0, alternatives = listOf("回复"), state = status))
            assertFalse(ContextEngine.canAct(archive))
        }
    }
    @Test fun `archive context does not read a different contact`() {
        val a = ContextEngine.append(ChatArchive(name = "同名", platform = "微信"), listOf(row("甲的内容")))
        val b = ContextEngine.append(ChatArchive(name = "同名", platform = "QQ"), listOf(row("乙的内容")))
        assertNotEquals(a.id, b.id)
        assertFalse(ContextEngine.prompt(a, "", "").contains("乙的内容"))
    }
    @Test fun `rewriting instructions belong to current prompt only`() {
        val archive = ContextEngine.append(ChatArchive(name = "甲"), listOf(row("你好")))
        assertTrue(ContextEngine.prompt(archive, "委婉拒绝", "").contains("委婉拒绝"))
        assertFalse(ContextEngine.prompt(archive, "", "").contains("委婉拒绝"))
    }
    @Test fun `summary sources are ordered existing originals`() {
        val rows = (1..60).map { row("消息$it") }
        val summaries = ContextEngine.summarize(rows)
        assertEquals(rows.dropLast(32).map { it.id }, summaries.flatMap { it.sourceIds })
    }
    @Test fun `later screenshot can prove a copied draft appeared after known dialogue`() {
        val known = listOf(row("周末有空吗"), row("周日下午", Speaker.ME), row("一起喝咖啡吧"))
        val archive = ContextEngine.append(ChatArchive(name = "甲"), known).let {
            it.copy(draft = ReplyDraft(contextRevision = it.revision, alternatives = listOf("可以呀"), state = DraftState.COPIED))
        }
        val observed = ContextEngine.append(archive, known.takeLast(2) + row("可以呀", Speaker.ME))
        assertEquals(DraftState.SENT, observed.draft!!.state)
        assertTrue(observed.messages.last().generated)
        assertFalse(observed.pending)
        assertEquals(observed, ContextEngine.markSent(observed))
    }
    @Test fun `uncertain vision records never become factual summaries or style examples`() {
        val rows = (1..45).map { row("不确定内容$it", Speaker.ME).copy(uncertain = true) }
        val archive = ContextEngine.append(ChatArchive(name = "甲"), rows)
        assertTrue(archive.summaries.isEmpty())
        val prompt = ContextEngine.prompt(archive, "", "")
        assertTrue(prompt.contains("识别不确定"))
        assertFalse(prompt.contains("本人真实表达示例"))
    }
    @Test fun `uncertain overlapping rows are preserved instead of silently deduplicated`() {
        val rows = listOf(row("甲"), row("乙", Speaker.ME))
        assertEquals(0, ContextEngine.overlap(rows, rows.map { it.copy(uncertain = true) }))
    }
    @Test fun `same reply text without adjacent dialogue does not prove draft was sent`() {
        val archive = ContextEngine.append(ChatArchive(name = "甲"), listOf(row("问候"))).let {
            it.copy(draft = ReplyDraft(contextRevision = it.revision, alternatives = listOf("好"), state = DraftState.COPIED))
        }
        assertEquals(DraftState.COPIED, ContextEngine.append(archive, listOf(row("好", Speaker.ME))).draft!!.state)
    }
}
