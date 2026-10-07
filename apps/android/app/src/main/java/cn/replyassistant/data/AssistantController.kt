package cn.replyassistant.data

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import cn.replyassistant.ai.ModelClient
import cn.replyassistant.ai.SkillBundle
import cn.replyassistant.domain.*
import cn.replyassistant.platform.ChatAccessibilityService
import cn.replyassistant.platform.ImageImporter
import cn.replyassistant.platform.NotificationReplies
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.io.File

class AssistantController(private val context: Context, private val models: ModelClient = ModelClient(), storageNamespace: String = "") {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val store = LocalStore(context, if (storageNamespace.isBlank()) "assistant.db" else "$storageNamespace.db")
    private val secrets = SecureSettings(context, if (storageNamespace.isBlank()) "model_settings" else "${storageNamespace}_settings")
    private val images = ImageImporter(context)
    private val skills = SkillBundle(context)
    private val mutable = MutableStateFlow(AssistantState())
    private var storageReady = false
    private var work: Job? = null
    private var workVersion = 0L
    val state: StateFlow<AssistantState> = mutable
    init {
        runCatching {
            val archives = store.archives().map { archive ->
                if (archive.draft?.state == DraftState.SUBMITTING) archive.copy(draft = archive.draft.copy(state = DraftState.UNKNOWN)) else archive
            }
            val preview = store.session()
            mutable.value = AssistantState(archives = archives, preview = preview, selectedArchiveId = preview?.archiveId)
            storageReady = true
            runCatching { secrets.read() }.onSuccess { settings -> mutable.value = mutable.value.copy(settings = settings,
                selectedArchiveId = preview?.archiveId ?: settings.lastArchiveId?.takeIf { id -> archives.any { it.id == id && it.enabled } }) }
                .onFailure { mutable.value = mutable.value.copy(error = "加密配置无法读取，请重新填写模型配置；聊天档案已保留") }
            val kept = (preview?.pages.orEmpty() + archives.flatMap { it.consultation.pages }).map { it.path }.toSet()
            File(context.cacheDir, "screenshots").listFiles()?.filter { it.path !in kept }?.forEach { it.delete() }
            persist()
        }.onFailure { mutable.value = mutable.value.copy(error = "本地数据或加密配置无法读取，请勿清除数据；可以重新填写模型配置后保存") }
    }
    private fun persist() { check(storageReady) { "本地数据库尚未成功读取，已阻止覆盖，请保留应用数据" }; store.save(mutable.value.archives, mutable.value.preview) }
    private fun update(transform: (AssistantState) -> AssistantState) {
        check(storageReady) { "本地数据库尚未成功读取，已阻止覆盖，请保留应用数据" }
        val next = transform(mutable.value)
        store.save(next.archives, next.preview)
        mutable.value = next
    }
    fun notice(text: String) { mutable.value = mutable.value.copy(notice = text, error = "") }
    fun reportError(text: String) { mutable.value = mutable.value.copy(error = text, notice = "") }
    fun selected(): ChatArchive? = mutable.value.archives.find { it.id == mutable.value.selectedArchiveId }
    fun mutateArchive(id: String, transform: (ChatArchive) -> ChatArchive) {
        update { old -> old.copy(archives = old.archives.map { if (it.id == id) transform(it) else it }) }
    }
    fun createArchive(name: String, platform: String, temporary: Boolean = false): String {
        require(name.isNotBlank()) { "请填写档案名称" }
        val archive = ChatArchive(name = name.trim(), platform = platform.trim().ifBlank { "通用截图" }, temporary = temporary)
        val previous = mutable.value.preview?.takeIf { it.pages.any { page -> page.includeVisual } }
        update { old -> old.copy(archives = old.archives + archive, selectedArchiveId = archive.id,
            preview = if (previous != null) PreviewSession(archiveId = archive.id, bindingConfirmed = true)
                else old.preview?.copy(archiveId = archive.id, bindingConfirmed = true, version = old.preview.version + 1)) }
        previous?.pages?.forEach { File(it.path).delete() }
        rememberArchive(archive.id)
        autoGenerate()
        return archive.id
    }
    fun selectArchive(id: String) {
        if (mutable.value.busy) return
        require(mutable.value.archives.any { it.id == id })
        val previous = mutable.value.preview?.takeIf { it.archiveId != id && it.pages.any { page -> page.includeVisual } }
        update { it.copy(selectedArchiveId = id, preview = if (previous != null) PreviewSession(archiveId = id, bindingConfirmed = true)
            else it.preview?.copy(archiveId = id, bindingConfirmed = true, version = it.preview.version + 1)) }
        previous?.pages?.forEach { File(it.path).delete() }
        rememberArchive(id)
        autoGenerate()
    }
    fun startPreview() {
        if (mutable.value.preview == null) update { it.copy(preview = PreviewSession(archiveId = it.selectedArchiveId,
            bindingConfirmed = it.selectedArchiveId != null, recommendedArchiveId = it.selectedArchiveId)) }
    }
    fun confirmBinding(confirmed: Boolean) { update { it.copy(preview = it.preview?.copy(bindingConfirmed = confirmed)) } }
    fun updatePreview(transform: (PreviewSession) -> PreviewSession) { update { it.copy(preview = it.preview?.let { p -> transform(p).copy(version = p.version + 1) }) } }
    private fun rememberArchive(id: String) {
        val next = mutable.value.settings.copy(lastArchiveId = id)
        secrets.save(next)
        mutable.value = mutable.value.copy(settings = next)
    }
    fun acceptScreenshotUpload() {
        saveSettings(mutable.value.settings.copy(screenshotUploadAccepted = true))
        if (mutable.value.settings.screenshotUploadAccepted && mutable.value.advisorArchiveId == null) autoGenerate()
    }
    private fun autoGenerate() {
        val current = mutable.value
        if (current.preview?.pages.isNullOrEmpty() || current.preview?.archiveId == null) return
        if (!current.settings.screenshotUploadAccepted) { notice("首次使用请确认截图将发送到你配置的模型服务"); return }
        if (selected()?.draft?.manuallyEdited == true) { notice("新截图已保留，你修改的草稿不会被覆盖；需要时点击重新生成"); return }
        generate(current.preview?.instruction.orEmpty(), automatic = true)
    }
    fun draftIsCurrent(): Boolean {
        val draft = selected()?.draft ?: return false
        val preview = mutable.value.preview
        return preview?.pages.isNullOrEmpty() || draft.previewVersion == preview?.version
    }
    fun closePreview() {
        if (mutable.value.busy) return
        mutable.value.preview?.pages?.forEach { File(it.path).delete() }
        update { old -> old.copy(preview = null, archives = old.archives.filterNot { it.temporary },
            selectedArchiveId = old.selectedArchiveId?.takeIf { id -> old.archives.any { it.id == id && !it.temporary } }) }
    }
    fun saveTemporary(id: String, name: String) {
        require(name.isNotBlank())
        mutateArchive(id) { it.copy(temporary = false, name = name.trim()) }
    }
    fun deleteArchive(id: String) {
        if (mutable.value.busy) return
        val files = mutable.value.archives.find { it.id == id }?.consultation?.pages.orEmpty() + mutable.value.preview?.takeIf { it.archiveId == id }?.pages.orEmpty()
        update { old -> old.copy(archives = old.archives.filterNot { it.id == id }, selectedArchiveId = old.selectedArchiveId?.takeUnless { it == id },
            preview = old.preview?.let { if (it.archiveId == id) null else it }, advisorArchiveId = old.advisorArchiveId?.takeUnless { it == id }) }
        files.forEach { File(it.path).delete() }
    }
    fun reviseMessages(id: String, rows: List<ChatMessage>) {
        update { state -> state.copy(archives = state.archives.map { if (it.id == id) ContextEngine.revise(it, rows) else it },
            preview = state.preview?.let { p -> if (p.archiveId != id) p else p.copy(version = p.version + 1, pages = p.pages.map { page ->
                if (page.includeVisual) page.copy(rows = rows.filter { it.sourceId == page.id }, corrected = true) else page
            }) }) }
    }
    fun setInstruction(text: String) { update { it.copy(preview = it.preview?.copy(instruction = text)) } }
    fun previewOverlayOpacity(bubble: Float, panel: Float) {
        require(bubble.isFinite() && panel.isFinite())
        mutable.value = mutable.value.copy(settings = mutable.value.settings.copy(bubbleOpacity = bubble.coerceIn(.2f,1f),panelOpacity = panel.coerceIn(.2f,1f)))
    }
    fun saveOverlayOpacity() {
        runCatching { secrets.save(mutable.value.settings) }.onSuccess { notice("透明度已保存") }.onFailure { reportError("透明度无法保存，请重试") }
    }
    fun saveSettings(settings: ModelSettings) {
        runCatching {
            models.validateEndpoint(settings.textEndpoint)
            if (settings.visionEndpoint.isNotBlank()) models.validateEndpoint(settings.visionEndpoint)
            val saved = settings.copy(lastArchiveId = mutable.value.settings.lastArchiveId,
                screenshotUploadAccepted = settings.screenshotUploadAccepted || mutable.value.settings.screenshotUploadAccepted,
                bubbleOpacity = mutable.value.settings.bubbleOpacity, panelOpacity = mutable.value.settings.panelOpacity)
            val previous = mutable.value.settings
            secrets.save(saved)
            if (previous.globalStyle != saved.globalStyle || previous.preferences != saved.preferences)
                update { state -> state.copy(archives = state.archives.map { it.copy(revision = it.revision + 1) }) }
            mutable.value = mutable.value.copy(settings = saved, error = "", notice = "设置已保存到手机")
        }.onFailure { reportError(it.message ?: "无法保存设置") }
    }
    fun importImages(uris: List<Uri>, forConsultation: Boolean = false): Job? {
        val advisorId = mutable.value.advisorArchiveId.takeIf { forConsultation }
        if (advisorId != null) return launchWork {
            val archive = mutable.value.archives.find { it.id == advisorId } ?: error("档案已删除")
            require(archive.consultation.pages.size + uris.size <= 8) { "最多8张截图" }
            val pages = mutableListOf<ScreenshotPage>()
            try {
                for (uri in uris) pages += images.import(uri)
                mutateArchive(advisorId) { it.copy(consultation = it.consultation.copy(pages = it.consultation.pages + pages, version = it.consultation.version + 1)) }
            } catch (e: Exception) { pages.forEach { File(it.path).delete() }; throw e }
            notice("咨询截图已加入，发送问题时一起交给模型")
        }

        cancelWork()
        mutable.value = mutable.value.copy(advisorArchiveId = null)
        return launchWork {
        require(uris.isNotEmpty()) { "没有收到图片" }
        require((mutable.value.preview?.pages?.size ?: 0) + uris.size <= 8) { "一次最多追加8张截图，请先处理当前内容" }
        startPreview()
        for (uri in uris) {
            val page = images.import(uri)
            updatePreview { it.copy(pages = it.pages + page) }
        }
        notice("截图已准备好")
        val importVersion = workVersion
        scope.launch { work?.join(); if (workVersion == importVersion) autoGenerate() }
        }
    }
    fun addCapturedPage(page: ScreenshotPage) {
        cancelWork()
        startPreview()
        if (mutable.value.preview!!.pages.size >= 8) { File(page.path).delete(); reportError("一次最多8张截图"); return }
        updatePreview { it.copy(pages = it.pages + page) }
        autoGenerate()
    }
    fun recognizePage(pageId: String) = launchWork {
        val page = mutable.value.preview?.pages?.find { it.id == pageId } ?: return@launchWork
        val recognized = images.recognize(page).copy(corrected = true)
        updatePreview { p -> p.copy(pages = p.pages.map { if (it.id == pageId) recognized else it }) }
        notice("本地 OCR 结果已加入纠错区，必要时修改后重新生成")
    }
    fun editDraft(text: String) { selected()?.let { archive ->
        if (archive.draft?.state in setOf(DraftState.SUBMITTING, DraftState.SUBMITTED, DraftState.UNKNOWN, DraftState.SENT)) return
        mutateArchive(archive.id) { it.copy(draft = it.draft?.copy(text = text, state = DraftState.EDITING, manuallyEdited = true)) }
    } }
    fun chooseAlternative(index: Int) { selected()?.let { archive ->
        if (archive.draft?.state in setOf(DraftState.SUBMITTING, DraftState.SUBMITTED, DraftState.UNKNOWN, DraftState.SENT)) return
        mutateArchive(archive.id) { it.copy(draftHistory = Personalization.rememberDraft(it), draft = it.draft?.let { d -> d.copy(selected = index, text = d.alternatives[index], state = DraftState.EDITING, manuallyEdited = false) }) }
    } }
    fun generate(instruction: String, automatic: Boolean = false) = launchWork {
        require(!mutable.value.settings.paused) { "辅助已暂停，请先在设置恢复" }
        var archive = selected() ?: error("请先选择或新建聊天档案")
        require(archive.draft?.state !in setOf(DraftState.SUBMITTING, DraftState.SUBMITTED, DraftState.UNKNOWN)) { "上次发送结果尚未核对，请先确认已发送或确认未发出" }
        val generationStarted = System.nanoTime()
        fun elapsed() = java.lang.String.format(java.util.Locale.ROOT,"%.1f",(System.nanoTime()-generationStarted)/1_000_000_000.0)
        val requestSettings = mutable.value.settings
        val preview = mutable.value.preview
        val skillContent = if (archive.skill.enabled) withContext(Dispatchers.IO) { skills.payload(instruction + "\n" + archive.messages.takeLast(32).joinToString("\n") { it.text }) } else ""
        if (!preview?.pages.isNullOrEmpty()) {
            require(mutable.value.settings.screenshotUploadAccepted) { "请先同意将截图发送到你配置的多模态模型服务" }
            require(preview!!.archiveId == archive.id) { "请先选择当前聊天对象" }
            if (automatic && archive.draft?.manuallyEdited == true) return@launchWork
            val snapshot = archive
            val result = models.screenshotReply(snapshot, preview.pages, preview.manualRows, instruction, requestSettings, skillContent)
            val latest = mutable.value.archives.find { it.id == snapshot.id } ?: error("档案已删除")
            require(mutable.value.settings.sameReplyConfiguration(requestSettings) && latest.revision == snapshot.revision && latest.skill == snapshot.skill && latest.memory == snapshot.memory && latest.preferences == snapshot.preferences && mutable.value.preview?.id == preview.id &&
                mutable.value.preview?.version == preview.version && mutable.value.selectedArchiveId == snapshot.id && latest.draft == snapshot.draft) {
                "有新消息、截图或草稿修改，请重新生成；原草稿已保留"
            }
            if (result.contactMismatch) { reportError(result.note.ifBlank { "画面可能属于其他对象，请切换聊天对象后重试" }); return@launchWork }
            if (result.needsMoreContext) { reportError(result.note.ifBlank { "截图内容不足，请补图或补充想怎么回" }); return@launchWork }
            val pages = preview.pages.zip(result.pages).map { (page, recognized) ->
                val rows = if (page.corrected) page.rows else recognized.messages.map {
                    ChatMessage(speaker = it.speaker, text = it.text.trim(), uncertain = it.uncertain || it.speaker == Speaker.UNKNOWN,
                        origin = Origin.SCREENSHOT, sourceId = page.id, generated = it.speaker == Speaker.ME &&
                            ((listOfNotNull(snapshot.draft) + snapshot.draftHistory).any { d -> it.text.trim() == d.text.trim() || it.text.trim() in d.alternatives.map(String::trim) } ||
                                snapshot.messages.any { m -> m.generated && m.text.trim() == it.text.trim() }))
                }
                val description = if (page.corrected) page.imageDescription else recognized.imageDescription.trim()
                val savedRows = if (!page.corrected && description.isNotBlank() && rows.none { it.text.contains(description) }) rows + ChatMessage(
                    speaker = Speaker.UNKNOWN, text = "[图片内容，发言归属不确定] $description", uncertain = true, origin = Origin.SCREENSHOT, sourceId = page.id)
                    else rows
                page.copy(rows = savedRows, includeVisual = true, imageDescription = description)
            }
            val sourceIds = pages.map { it.id }.toSet() + preview.manualRows.map { it.sourceId }
            var merged = snapshot.copy(messages = snapshot.messages.filterNot { it.sourceId in sourceIds })
            pages.forEach { merged = ContextEngine.append(merged, it.rows, observeDraft = false) }
            merged = ContextEngine.append(merged, preview.manualRows, observeDraft = false)
            merged = merged.copy(revision = snapshot.revision + 1, summaries = ContextEngine.summarize(merged.messages), memory = Personalization.invalidateMemory(snapshot, merged.messages))
            if (snapshot.skill.enabled) require(result.advisor != null) { "军师分析缺失，截图和草稿已保留，请重试" }
            val certain = merged.messages.filter { !it.uncertain && it.speaker != Speaker.UNKNOWN }.flatMap { listOf(it.id,it.sourceId) }.toSet() -
                merged.messages.filter { it.uncertain }.map { it.sourceId }.toSet()
            merged = Personalization.applyMemory(merged, result.memorySuggestions, certain, emptySet())
            val next = merged.copy(draftHistory = Personalization.rememberDraft(snapshot), draft = ReplyDraft(contextRevision = merged.revision, alternatives = result.alternatives,
                instruction = instruction, note = result.note.ifBlank { if (pages.any { p -> p.rows.any { it.uncertain } }) "部分识别内容不确定，可在补充／纠正查看" else "" },
                uncertain = result.uncertain || pages.any { p -> p.rows.any { it.uncertain } }, previewVersion = preview.version, advisor = result.advisor))
            update { state -> state.copy(archives = state.archives.map { if (it.id == next.id) next else it }, preview = preview.copy(pages = pages)) }
            notice(if (merged.memory != snapshot.memory) "建议已生成（${elapsed()}秒），关系记忆已更新，可查看或撤销" else "建议已生成（${elapsed()}秒），填写和复制都不会发送")
            return@launchWork
        }
        if (preview != null) {
            require(preview.archiveId == archive.id && preview.bindingConfirmed) { "请先确认当前截图的档案归属" }
            val rows = preview.pages.flatMap { it.rows } + preview.manualRows
            require(rows.isNotEmpty()) { "请追加截图或聊天内容" }
            require(rows.none { it.uncertain || it.speaker == Speaker.UNKNOWN || it.text.isBlank() }) { "请确认识别内容及每条的说话人" }
            require(mutable.value.settings.textKey.isNotBlank()) { "请先在设置中填写文字模型 API Key，截图预览已保留" }
            models.validateEndpoint(mutable.value.settings.textEndpoint)
            // Merge one page at a time, preserving the ordered overlap between screenshots.
            preview.pages.forEach { archive = ContextEngine.append(archive, it.rows.map { row -> row.copy(imagePath = null) }) }
            archive = ContextEngine.append(archive, preview.manualRows)
            val stored = archive
            mutateArchive(archive.id) { stored }
            preview.pages.forEach { File(it.path).delete() }
            update { it.copy(preview = null) }
        }
        require(archive.messages.isNotEmpty()) { "当前档案没有聊天内容，请先追加截图或读取聊天" }
        val snapshot = archive
        val result = models.reply(snapshot, instruction, requestSettings, skillContent)
        val latest = mutable.value.archives.find { it.id == snapshot.id } ?: error("档案已删除")
        require(latest.revision == snapshot.revision && latest.skill == snapshot.skill && latest.memory == snapshot.memory && latest.preferences == snapshot.preferences && latest.draft == snapshot.draft && mutable.value.settings.sameReplyConfiguration(requestSettings) && mutable.value.selectedArchiveId == snapshot.id) { "有新消息或内容修改，请重新生成；原草稿已保留" }
        if (snapshot.skill.enabled) require(result.advisor != null) { "军师分析缺失，请重试" }
        mutateArchive(snapshot.id) { existing ->
            val sources = existing.messages.filter { !it.uncertain && it.speaker != Speaker.UNKNOWN }.flatMap { listOf(it.id,it.sourceId) }.toSet() - existing.messages.filter { it.uncertain }.map { it.sourceId }.toSet()
            val it = Personalization.applyMemory(existing, result.memorySuggestions, sources, emptySet())
            it.copy(draftHistory = Personalization.rememberDraft(it), draft = ReplyDraft(contextRevision = snapshot.revision,
            alternatives = result.alternatives, instruction = instruction, note = result.note, uncertain = result.uncertain, advisor = result.advisor)) }
        notice(if (result.uncertain) "建议已生成（${elapsed()}秒），但有背景需要补充" else "回复建议已生成（${elapsed()}秒），确认前不会发送")
    }
    fun copyDraft() {
        val archive = selected() ?: return
        require(ContextEngine.canAct(archive) && draftIsCurrent()) { "上下文已更新或该回复已处理，请重新检查" }
        val text = archive.draft!!.text
        (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("回复", text))
        mutateArchive(archive.id) { it.copy(draft = it.draft?.copy(state = DraftState.COPIED)) }
        notice("已复制，尚未标记为发送")
    }
    fun fillDraft(): Boolean {
        val archive = selected() ?: return false
        require(ContextEngine.canAct(archive) && draftIsCurrent()) { "上下文已更新，请重新检查或生成" }
        val result = ChatAccessibilityService.fill(archive.draft!!.text)
        if (result) { mutateArchive(archive.id) { it.copy(draft = it.draft?.copy(state = DraftState.FILLED)) }; notice("已填入，请在原软件检查并点击发送") }
        else notice("无法确认填写结果，请检查原输入框；已有文字或无法定位时使用复制")
        return result
    }
    fun acknowledgeSent() { selected()?.let { archive ->
        require(draftIsCurrent() || archive.draft?.state in setOf(DraftState.SUBMITTED, DraftState.UNKNOWN, DraftState.SENT)) { "截图已更新，请先核对草稿" }
        mutateArchive(archive.id) { ContextEngine.markSent(it) }; notice("已记录你确认发送的内容")
    } }
    fun acknowledgeNotSent() { selected()?.let { archive ->
        require(archive.draft?.state in setOf(DraftState.SUBMITTED, DraftState.UNKNOWN))
        mutateArchive(archive.id) { it.copy(draft = it.draft?.copy(state = DraftState.EDITING, note = "本人已核对上次未发出，请检查最新上下文后操作")) }
        notice("已记录你核对上次未发出，不会自动重发")
    } }
    fun reviewDraft() { selected()?.let { archive ->
        require(archive.draft != null && archive.draft.state !in setOf(DraftState.SUBMITTING, DraftState.SUBMITTED, DraftState.UNKNOWN, DraftState.SENT))
        mutateArchive(archive.id) { it.copy(draft = it.draft?.copy(contextRevision = it.revision, previewVersion = mutable.value.preview?.version)) }
        notice("已记录你核对最新上下文，草稿仍未发送")
    } }
    fun dismissPending() { selected()?.let { archive -> mutateArchive(archive.id) { it.copy(pending = false) }; notice("本轮暂不回复，后续新消息仍会提示") } }
    fun sendNotification() {
        val archive = selected() ?: return
        require(ContextEngine.canAct(archive) && draftIsCurrent()) { "上下文已更新或回复已处理，请重新检查" }
        require(!mutable.value.settings.paused) { "辅助已暂停" }
        val draft = archive.draft!!
        val scopeKey = requireNotNull(archive.notificationScope) { "该档案没有通知快捷回复入口，请使用复制" }
        require(NotificationReplies.canSend(scopeKey, archive)) { "快捷回复入口已失效或未经验证，请使用复制" }
        mutateArchive(archive.id) { it.copy(draft = draft.copy(state = DraftState.SUBMITTING)) }
        // Persist SUBMITTING before invoking an external action; no automatic retry on a crash.
        val submitted = NotificationReplies.send(context, scopeKey, archive, draft.text)
        mutateArchive(archive.id) { it.copy(draft = draft.copy(state = if (submitted) DraftState.SUBMITTED else DraftState.UNKNOWN)) }
        notice(if (submitted) "已提交给原软件，尚未确认送达。请核对后点击“我已发送”" else "发送结果不明，请到原聊天核对；不会自动重试")
    }
    fun receiveNotification(scopeKey: String, name: String, platform: String, rows: List<ChatMessage>) {
        scope.launch {
            if (mutable.value.settings.paused) return@launch
            val archive = mutable.value.archives.find { it.notificationScope == scopeKey }
            if (archive == null) {
                // Discovery retains only a label; message bodies are not stored until explicitly enabled.
                update { old -> old.copy(archives = old.archives.filter { it.enabled } + old.archives.filterNot { it.enabled }.takeLast(29) +
                    ChatArchive(name = name, platform = platform, enabled = false, notificationScope = scopeKey)) }
            } else if (archive.enabled) mutateArchive(archive.id) { existing ->
                val known = existing.messages.map { it.sourceId }.toSet()
                ContextEngine.append(existing, rows.filter { it.sourceId !in known })
            }
        }
    }
    fun enableArchive(id: String, enabled: Boolean) { mutateArchive(id) { archive ->
        val bound = archive.copy(enabled = enabled)
        if (enabled && archive.notificationScope != null) {
            val existing = archive.messages.map { it.sourceId }.toSet()
            ContextEngine.append(bound, NotificationReplies.pendingRows(archive.notificationScope).filter { it.sourceId !in existing })
        } else bound
    } }
    fun readCurrentChat() {
        val rows = ChatAccessibilityService.readCurrent() ?: run { reportError("请在目标聊天中打开悬浮面板，再读取当前聊天"); return }
        startPreview()
        updatePreview { it.copy(manualRows = it.manualRows + rows, bindingConfirmed = false) }
        notice("已读取当前可见文字，请确认说话人并删除界面按钮和标题")
    }

    fun openAdvisor(id: String) {
        require(!mutable.value.busy) { "请等待当前请求完成" }
        require(mutable.value.archives.any { it.id == id && it.enabled })
        mutable.value = mutable.value.copy(advisorArchiveId = id)
    }
    fun closeAdvisor() { if (!mutable.value.busy) mutable.value = mutable.value.copy(advisorArchiveId = null) }
    fun setSkill(id: String, enabled: Boolean) = mutateArchive(id) { it.copy(skill = it.skill.copy(enabled = enabled), revision = it.revision + 1) }
    fun feedback(kind: String, correction: String = "") {
        val archive = selected() ?: return
        val draft = archive.draft ?: return
        require(draft.state !in setOf(DraftState.SUBMITTING,DraftState.SUBMITTED,DraftState.UNKNOWN,DraftState.SENT)) { "该回复已处理，请先重新生成" }
        val requirement = when (kind) {
            "太长了" -> "更简短，保留关键信息，不改变事实"
            "不像我" -> "更贴近本人真实表达示例和明确偏好，不套用通用客套话"
            "语气不对" -> "语气更自然，符合当前关系，不比本人更热情或正式"
            "事实不对" -> { require(correction.isNotBlank()) { "请先填写事实纠正" }; "以本人纠正为准：$correction" }
            else -> error("未知反馈")
        }
        mutateArchive(archive.id) { it.copy(draftHistory = Personalization.rememberDraft(it),
            feedback = (it.feedback + FeedbackRecord(kind = kind,instruction = requirement,draftId = draft.id)).takeLast(100)) }
        generate(listOf(draft.instruction,requirement).filter { it.isNotBlank() }.joinToString("\n"))
    }
    fun savePreference(text: String, global: Boolean, id: String? = null) {
        require(text.isNotBlank() && text.length <= 1000) { "偏好需要1至1000字" }
        val preference = SavedPreference(id = id ?: newId(), text = text.trim())
        if (global) {
            val settings = mutable.value.settings
            saveSettings(settings.copy(preferences = settings.preferences.filterNot { it.id == preference.id } + preference))
        } else selected()?.let { a -> mutateArchive(a.id) { it.copy(preferences = it.preferences.filterNot { it.id == preference.id } + preference, revision = it.revision + 1) } }
    }
    fun deletePreference(id: String, global: Boolean) {
        if (global) saveSettings(mutable.value.settings.copy(preferences = mutable.value.settings.preferences.filterNot { it.id == id }))
        else selected()?.let { a -> mutateArchive(a.id) { it.copy(preferences = it.preferences.filterNot { it.id == id }, revision = it.revision + 1) } }
    }
    fun restoreDraft(id: String) {
        val archive = selected() ?: return
        require(archive.draft?.state !in setOf(DraftState.SUBMITTING,DraftState.SUBMITTED,DraftState.UNKNOWN)) { "请先核对上次发送结果" }
        val old = archive.draftHistory.find { it.id == id } ?: return
        mutateArchive(archive.id) { it.copy(draftHistory = Personalization.rememberDraft(it), draft = old.copy(id = newId(),state = DraftState.EDITING,manuallyEdited = true)) }
        notice("旧草稿已恢复，请核对最新上下文后复制或填入")
    }
    fun teachSample(id: String, checked: Boolean) {
        val archive = selected() ?: return
        val row = archive.messages.find { it.id == id } ?: return
        require(row.speaker == Speaker.ME && !row.generated && !row.uncertain) { "仅能标记已确认且非AI生成的本人发言" }
        update { state -> state.copy(archives = state.archives.map { a -> if (a.id != archive.id) a else a.copy(
            messages = a.messages.map { m -> if (m.id == id) m.copy(styleExample = checked) else m },revision = a.revision + 1) },
            preview = state.preview?.let { p -> if (p.archiveId != archive.id) p else p.copy(version = p.version + 1,pages = p.pages.map { page ->
                if (page.rows.none { it.id == id }) page else page.copy(corrected = true,rows = page.rows.map { m -> if (m.id == id) m.copy(styleExample = checked) else m })
            }) }) }

    }
    fun editConsultation(id: String, question: String, background: String) = mutateArchive(id) {
        it.copy(consultation = it.consultation.copy(question = question,background = background,version = it.consultation.version + 1))
    }
    fun removeConsultImage(id: String, pageId: String) {
        val page = mutable.value.archives.find { it.id == id }?.consultation?.pages?.find { it.id == pageId } ?: return
        mutateArchive(id) { it.copy(consultation = it.consultation.copy(pages = it.consultation.pages.filterNot { p -> p.id == pageId },version = it.consultation.version + 1)) }
        File(page.path).delete()
    }
    fun consult(id: String) = launchWork {
        require(!mutable.value.settings.paused) { "辅助已暂停" }
        val snapshot = mutable.value.archives.find { it.id == id } ?: error("档案已删除")
        require(snapshot.skill.enabled) { "请先为此对象启用狗头军师" }
        val settings = mutable.value.settings
        require(snapshot.consultation.pages.isEmpty() || settings.screenshotUploadAccepted) { "请先同意截图上传" }
        val questionId = newId()
        val result = models.consult(snapshot,questionId,settings,skills.payload(snapshot.consultation.question + "\n" + snapshot.consultation.background + "\n" + snapshot.messages.takeLast(32).joinToString("\n") { it.text }))
        val latest = mutable.value.archives.find { it.id == id } ?: error("档案已删除")
        require(latest == snapshot && mutable.value.settings.sameReplyConfiguration(settings) && mutable.value.advisorArchiveId == id) { "资料或问题已改变，旧结果未采用，请重试" }
        require(!result.contactMismatch) { result.note.ifBlank { "截图可能属于其他对象，请更换截图或对象" } }
        val turn = ConsultTurn(id = questionId,question = snapshot.consultation.question,background = snapshot.consultation.background,
            analysis = requireNotNull(result.advisor),replies = result.alternatives,
            imageDescriptions = result.pages.map { p -> (p.messages.map { "${it.speaker}：${it.text}${if(it.uncertain) " [不确定]" else ""}" } + p.imageDescription).joinToString("\n") },
            sourceIds = result.pages.map { it.sourceId })
        val certain = snapshot.messages.filter { !it.uncertain && it.speaker != Speaker.UNKNOWN }.flatMap { listOf(it.id,it.sourceId) }.toSet() -
            snapshot.messages.filter { it.uncertain }.map { it.sourceId }.toSet() + result.pages.filter { p -> p.messages.isNotEmpty() && p.messages.none { it.uncertain || it.speaker == Speaker.UNKNOWN } }.map { it.sourceId }
        val updated = Personalization.applyMemory(snapshot,result.memorySuggestions,certain,(snapshot.consultation.turns.map { it.id } + questionId).toSet())
        mutateArchive(id) { updated.copy(consultation = snapshot.consultation.copy(turns = snapshot.consultation.turns + turn,question = "",background = "",pages = emptyList(),version = snapshot.consultation.version + 1)) }
        snapshot.consultation.pages.forEach { File(it.path).delete() }
        notice(if (updated.memory != snapshot.memory) "咨询完成，关系记忆已更新，可查看或撤销" else "咨询完成，不会发送消息")
    }
    fun useConsultReply(id: String, turnId: String, index: Int) {
        require(!mutable.value.busy)
        val archive = mutable.value.archives.find { it.id == id } ?: return
        require(archive.draft?.state !in setOf(DraftState.SUBMITTING,DraftState.SUBMITTED,DraftState.UNKNOWN)) { "请先核对上次发送结果" }
        val turn = archive.consultation.turns.find { it.id == turnId } ?: return
        require(index in turn.replies.indices)
        mutateArchive(id) { it.copy(draftHistory = Personalization.rememberDraft(it), draft = ReplyDraft(contextRevision = it.revision,
            alternatives = turn.replies,selected = index,text = turn.replies[index],previewVersion = mutable.value.preview?.takeIf { it.archiveId == id }?.version,
            note = "来自军师咨询，请核对当前聊天再发送", advisor = turn.analysis)) }
        mutable.value = mutable.value.copy(selectedArchiveId = id,advisorArchiveId = null)
        notice("已转为回复草稿，尚未发送")
    }
    fun changeMemory(id: String, action: String, profile: String = "") {
        mutateArchive(id) { a ->
            val m = a.memory
            val next = when(action) {
                "enable" -> m.copy(consent = true,paused = false)
                "pause" -> m.copy(paused = true)
                "resume" -> m.copy(paused = false)
                "profile" -> { require(profile.length <= 4000); m.copy(profile = profile) }
                "undo" -> if (m.undo.isEmpty()) m else m.copy(entries = m.undo.last(),undo = m.undo.dropLast(1))
                "delete" -> RelationshipMemory()
                else -> error("未知记忆操作")
            }
            a.copy(memory = next,revision = a.revision + 1)
        }
        notice("关系记忆已更新")
    }
    fun deleteConsultation(id: String) {
        require(!mutable.value.busy)
        val a = mutable.value.archives.find { it.id == id } ?: return
        val sources = a.consultation.turns.flatMap { it.sourceIds + it.id }.toSet()
        mutateArchive(id) { it.copy(consultation = Consultation(),memory = it.memory.copy(
            entries = it.memory.entries.filter { e -> e.sourceIds.none(sources::contains) },
            undo = it.memory.undo.map { entries -> entries.filter { e -> e.sourceIds.none(sources::contains) } }),revision = it.revision + 1) }
        a.consultation.pages.forEach { File(it.path).delete() }
    }

    private fun cancelWork() { workVersion++; work?.cancel(); work = null; mutable.value = mutable.value.copy(busy = false) }
    private fun launchWork(block: suspend () -> Unit): Job? {
        if (mutable.value.busy) return null
        mutable.value = mutable.value.copy(busy = true, error = "", notice = "")
        val version = ++workVersion
        return scope.launch(start = CoroutineStart.LAZY) {
            try { block() } catch (e: CancellationException) { throw e }
            catch (e: Exception) { reportError(e.message?.take(240) ?: "操作失败，原有内容已保留") }
            finally { if (version == workVersion) mutable.value = mutable.value.copy(busy = false) }
        }.also { work = it; it.start() }
    }
}
