package cn.replyassistant.domain

object Personalization {
    fun samples(archive: ChatArchive): List<ChatMessage> = archive.messages.filter {
        it.speaker == Speaker.ME && !it.generated && !it.uncertain &&
            (it.styleExample || it.origin == Origin.MANUAL || it.origin == Origin.ACCESSIBILITY)
    }
    fun prompt(archive: ChatArchive): String = buildString {
        val samples = samples(archive)
        if (samples.size >= 10) {
            val average = samples.map { it.text.codePointCount(0, it.text.length) }.average().toInt()
            appendLine("本人表达统计（仅作参考，明确偏好优先）：平均约${average}字。")
            val stop = samples.count { it.text.trim().endsWith("。") }.toDouble() / samples.size
            if (stop <= .1) appendLine("通常不在句尾加句号。")
            if (stop >= .8) appendLine("通常在句尾加句号。")
            if (samples.count { m -> m.text.codePoints().anyMatch { it in 0x1F300..0x1FAFF } }.toDouble() / samples.size >= .3)
                appendLine("本人经常使用表情，适合时可少量使用。")
            val habits = listOf("哈哈", "嗯嗯", "呀", "啦", "哦", "~", "～").filter { h -> samples.count { h in it.text } >= maxOf(3, kotlin.math.ceil(samples.size * .2).toInt()) }
            if (habits.isNotEmpty()) appendLine("常用表达：${habits.take(6).joinToString("、")}；不要每句强行添加。")
        }
        val ids = samples.map { it.id }.toSet()
        val pairs = archive.messages.zipWithNext().filter { (a,b) -> a.speaker == Speaker.OTHER && !a.uncertain && b.id in ids }.takeLast(8)
        if (pairs.isNotEmpty()) appendLine("本人真实表达示例：")
        pairs.forEach { (a,b) -> appendLine("对方：${a.text.take(300)} → 本人：${b.text.take(300)}") }
        if (pairs.isEmpty()) samples.takeLast(8).forEach { appendLine("本人真实表达示例：${it.text.take(300)}") }
    }
    fun rememberDraft(archive: ChatArchive): List<ReplyDraft> {
        val draft = archive.draft ?: return archive.draftHistory
        return if (draft.manuallyEdited && draft.text.isNotBlank() && archive.draftHistory.none { it.contextRevision == draft.contextRevision && it.text == draft.text })
            (archive.draftHistory + draft.copy(id = newId())).takeLast(30) else archive.draftHistory
    }
    fun invalidateMemory(archive: ChatArchive, rows: List<ChatMessage>): RelationshipMemory {
        val changed = archive.messages.filter { old -> rows.find { it.id == old.id } != old }.flatMap { listOf(it.id,it.sourceId) }.toSet()
        fun valid(entries: List<MemoryEntry>) = entries.filter { it.sourceIds.none(changed::contains) }
        return archive.memory.copy(entries = valid(archive.memory.entries), undo = archive.memory.undo.map(::valid))
    }
    fun applyMemory(archive: ChatArchive, suggestions: List<MemorySuggestion>, certainSources: Set<String>, reportSources: Set<String>): ChatArchive {
        if (!archive.memory.consent || archive.memory.paused) return archive
        val additions = suggestions.take(20).filter { s ->
            s.text.isNotBlank() && s.text.length <= 1000 && s.sourceIds.isNotEmpty() && s.sourceIds.size <= 20 &&
                s.kind in setOf("fact", "user_report", "hypothesis") && s.sourceIds.all {
                    it in certainSources || (s.kind != "fact" && it in reportSources)
                }
        }.filter { s -> archive.memory.entries.none { it.kind == s.kind && it.text == s.text && it.sourceIds == s.sourceIds } }
            .map { MemoryEntry(kind = it.kind, text = it.text, sourceIds = it.sourceIds) }
        if (additions.isEmpty()) return archive
        return archive.copy(memory = archive.memory.copy(entries = (archive.memory.entries + additions).takeLast(60),
            undo = (archive.memory.undo + listOf(archive.memory.entries)).takeLast(10)))
    }
}
