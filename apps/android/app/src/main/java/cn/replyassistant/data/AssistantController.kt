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
    private val usage=MobileUsageStore(context,storageNamespace)
    private val images = ImageImporter(context)
    private val skills = SkillBundle(context)
    private val linkClient = LinkClient()
    private var linkJob: Job? = null
    private var linkApplying = false
    private var linkRequested = false
    private val mutable = MutableStateFlow(AssistantState())
    private var storageReady = false
    private var work: Job? = null
    private var workVersion = 0L
    private var workArchiveId:String?=null
    private val panelPositions = mutableMapOf<String, ReplyPanelPosition>()
    fun panelPosition(id: String) = panelPositions[id] ?: ReplyPanelPosition()
    fun savePanelPosition(id: String, position: ReplyPanelPosition) { panelPositions[id] = position }
    val state: StateFlow<AssistantState> = mutable
    private var backupPassword:CharArray?=null
    private var pendingBackup:BackupPayload?=null
    fun usageSnapshot()=usage.snapshot()
    /** Explicit maintenance request: paired archives and labelled synthetic archives only. */
    fun clearSyncedAndSyntheticHistory(includeAll:Boolean=false){
        cancelWork()
        val ids=mutable.value.archives.filter {includeAll||it.desktop!=null||it.name.contains("合成")||it.name.startsWith("测试")||it.name.startsWith("Synthetic",true)}.map {it.id}.toSet()
        val oldPreview=mutable.value.preview
        update {state->state.copy(archives=state.archives.map {a->if(a.id !in ids)a else a.copy(messages=emptyList(),summaries=emptyList(),draft=null,draftHistory=emptyList(),historyUndo=null,replyAttempt=null,lastDecisionV2=null,pending=false,consultation=Consultation(),relationship="",style="",preferences=emptyList(),feedback=emptyList(),memory=RelationshipMemory(),revision=a.revision+1,desktop=a.desktop?.copy(cursor=0,records=emptyList(),packet=ContextPacket(),conflicts=emptyList(),exportedProfile=null,messageBaseVersions=emptyMap(),resetRevision=0))},preview=if(oldPreview?.archiveId in ids)null else oldPreview?.copy(heldBatches=oldPreview.heldBatches.filterNot {it.archiveId in ids}),error="",notice="已清理同步记录和合成测试资料，模型配置与费用记录保留")}
        val kept=(mutable.value.preview?.pages.orEmpty()+mutable.value.preview?.heldBatches.orEmpty().flatMap {it.pages}+mutable.value.archives.flatMap {it.consultation.pages}).map {it.path}.toSet()
        File(context.cacheDir,"screenshots").listFiles()?.filter {it.path !in kept}?.forEach {it.delete()}
    }
    fun prepareBackup(password:String){require(password.length>=8){"备份密码至少8位"};backupPassword?.fill('\u0000');backupPassword=password.toCharArray()}
    fun cancelBackup(){backupPassword?.fill('\u0000');backupPassword=null;pendingBackup=null;mutable.value=mutable.value.copy(backupPreview=null)}
    fun exportBackup(uri:Uri){scope.launch {
        if(mutable.value.backupBusy)return@launch
        val password=backupPassword?:return@launch;backupPassword=null
        val payload=ArchiveBackup.payload(mutable.value.archives,mutable.value.settings);mutable.value=mutable.value.copy(backupBusy=true)
        try {withContext(Dispatchers.IO){val bytes=ArchiveBackup.encrypt(payload,password);context.contentResolver.openOutputStream(uri,"wt")?.use {it.write(bytes)}?:error("文件无法写入")};notice("加密备份已保存，密码、模型密钥和连接凭据均未导出")}
        catch(e:Exception){reportError("备份未完成：${e.message.orEmpty().take(100)}")}
        finally{password.fill('\u0000');mutable.value=mutable.value.copy(backupBusy=false)}
    }}
    fun importBackup(uri:Uri){scope.launch {
        if(mutable.value.backupBusy)return@launch
        val password=backupPassword?:return@launch;backupPassword=null;pendingBackup=null;mutable.value=mutable.value.copy(backupBusy=true,backupPreview=null)
        try {val payload=withContext(Dispatchers.IO){val bytes=context.contentResolver.openInputStream(uri)?.use {it.readNBytes(ArchiveBackup.MAX_BYTES+1)}?:error("文件无法读取");ArchiveBackup.decrypt(bytes,password)};pendingBackup=payload;mutable.value=mutable.value.copy(backupPreview=ArchiveBackup.preview(payload,mutable.value.archives.map {it.id}.toSet()))}
        catch(_:Exception){reportError("无法读取备份：密码错误、文件损坏或版本不支持。现有资料未改动")}
        finally{password.fill('\u0000');mutable.value=mutable.value.copy(backupBusy=false)}
    }}
    fun restoreBackup(includePreferences:Boolean){
        require(!mutable.value.busy&&!mutable.value.linkBusy&&!mutable.value.backupBusy){"请等待当前生成或同步完成"};val p=pendingBackup?:error("请先选择并预览备份")
        val merged=ArchiveBackup.merge(mutable.value.archives,p);update {it.copy(archives=merged,backupPreview=null)}
        if(includePreferences)saveSettings(mutable.value.settings.copy(globalStyle=p.globalStyle,preferences=(mutable.value.settings.preferences+p.preferences).distinctBy {it.id}))
        cancelBackup();notice("已恢复新增档案；同ID档案保留手机当前版本，模型配置与费用记录保留，恢复档案需重新关联电脑")
    }
    init {
        models.reserveCall={settings,role,model,input,output->usage.reserve(settings,role,model,input,output)}
        models.completeCall={id,input,output,status->usage.complete(id,input,output,status)}
        runCatching {
            val archives = store.archives().map { archive ->
                (if (archive.draft?.state == DraftState.SUBMITTING) archive.copy(draft = archive.draft.copy(state = DraftState.UNKNOWN)) else archive).recoverReplyAttempt()
            }
            val preview = store.session()
            mutable.value = AssistantState(archives = archives, preview = preview, selectedArchiveId = preview?.archiveId)
            storageReady = true
            runCatching { secrets.read() }.onSuccess { settings -> mutable.value = mutable.value.copy(settings = settings,
                linkStatus = if(settings.linkConnection!=null) "已配对，连接电脑后同步；已下载资料可离线使用" else "未连接电脑",
                selectedArchiveId = preview?.archiveId ?: settings.lastArchiveId?.takeIf { id -> archives.any { it.id == id && it.enabled } }) }
                .onFailure { mutable.value = mutable.value.copy(error = "加密配置无法读取，请重新填写模型配置；聊天档案已保留") }
            val kept = (preview?.pages.orEmpty() + preview?.heldBatches.orEmpty().flatMap { it.pages } + archives.flatMap { it.consultation.pages }).map { it.path }.toSet()
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
        if (!linkApplying && next.settings.linkConnection != null) scheduleLinkSync()
    }
    private fun scheduleLinkSync() {
        if(mutable.value.linkNeedsPairing)return
        linkRequested = true
        if (linkJob?.isActive == true) return
        linkJob = scope.launch { do { delay(1500); if(!mutable.value.linkBusy){linkRequested=false;syncDesktopNow()} } while(linkRequested && mutable.value.settings.linkConnection != null && !mutable.value.linkNeedsPairing) }
    }
    fun desktopForeground() { if (mutable.value.settings.linkConnection != null && !mutable.value.linkNeedsPairing) scheduleLinkSync() }
    fun openLink(id:String?=mutable.value.selectedArchiveId) { mutable.value=mutable.value.copy(linkScreen=true,linkArchiveId=id) }
    fun closeLink() { mutable.value=mutable.value.copy(linkScreen=false) }
    private fun linkFailed(e:Exception) { mutable.value=mutable.value.copy(linkNeedsPairing=mutable.value.linkNeedsPairing||e is LinkHttpException&&e.status==401,
        linkStatus=if(e is LinkHttpException)e.message.orEmpty() else if(e is java.io.IOException) "电脑暂时不可达，手机继续使用已下载资料；修改保留在手机，下次连接续传" else e.message ?: "联动未完成") }
    fun pairDesktop(text:String) { scope.launch {
        if(mutable.value.linkBusy)return@launch
        mutable.value=mutable.value.copy(linkBusy=true,linkStatus="正在连接电脑…")
        try { val connection=linkClient.pair(text); val settings=mutable.value.settings.copy(linkConnection=connection)
            secrets.save(settings);mutable.value=mutable.value.copy(settings=settings,linkNeedsPairing=false,desktopContacts=emptyList(),linkStatus="电脑已配对，请选择当前对象的电脑联系人")
            mutable.value=mutable.value.copy(desktopContacts=linkClient.contacts(connection))
        } catch(e:Exception) { linkFailed(e) }
        finally { mutable.value=mutable.value.copy(linkBusy=false) }
    } }
    fun refreshDesktopContacts() { scope.launch {
        if(mutable.value.linkBusy)return@launch
        val connection=mutable.value.settings.linkConnection ?: return@launch
        mutable.value=mutable.value.copy(linkBusy=true,linkStatus="正在读取电脑联系人…")
        try {
        mutable.value=mutable.value.copy(desktopContacts=linkClient.contacts(connection))
        mutable.value=mutable.value.copy(linkStatus="电脑联系人已更新，选择同一个聊天对象进行关联")
    } catch(e:Exception) { linkFailed(e) } finally {mutable.value=mutable.value.copy(linkBusy=false)} } }
    fun bindDesktop(id:String,contact:String?) { scope.launch {
        if(mutable.value.linkBusy)return@launch
        mutable.value=mutable.value.copy(linkBusy=true)
        try { val connection=mutable.value.settings.linkConnection ?: error("请先配对电脑")
            val archive=mutable.value.archives.find {it.id==id} ?: error("档案不存在")
            val linked=linkClient.bind(connection,archive,contact).copy(contactLabel=mutable.value.desktopContacts.find {it.id==contact}?.let {"${it.name} · ${it.platform}"} ?: "仅整理手机资料")
            mutateArchive(id) {it.copy(desktop=linked)}
            mutable.value=mutable.value.copy(linkStatus="已关联，正在同步")
        }catch(e:Exception){linkFailed(e)}
        finally { mutable.value=mutable.value.copy(linkBusy=false);scheduleLinkSync() }
    } }
    fun disconnectDesktop() {
        require(!mutable.value.linkBusy) { "同步中，请稍后断开" }
        val settings=mutable.value.settings.copy(linkConnection=null)
        secrets.save(settings);mutable.value=mutable.value.copy(settings=settings,desktopContacts=emptyList(),linkNeedsPairing=false,linkStatus="已断开，已下载资料仍可离线使用")
    }
    fun unlinkDesktop(id:String) { scope.launch {
        if(mutable.value.linkBusy)return@launch
        mutable.value=mutable.value.copy(linkBusy=true,linkStatus="正在解除关联…")
        try {
        val a=mutable.value.archives.find {it.id==id} ?: return@launch
        val c=mutable.value.settings.linkConnection ?: error("请连接电脑后解除关联")
        val g=a.desktop ?: return@launch
        linkClient.call(c,"groups/${g.groupId}/unbind",kotlinx.serialization.json.buildJsonObject {})
        mutateArchive(id) {it.copy(desktop=it.desktop?.copy(active=false),revision=it.revision+1)}
        mutable.value=mutable.value.copy(linkStatus="已解除关联，手机资料保留")
    }catch(e:Exception){linkFailed(e)}finally{mutable.value=mutable.value.copy(linkBusy=false)}} }
    fun resolveDesktop(id:String,recordId:String,side:String) {scope.launch {
        if(mutable.value.linkBusy)return@launch
        mutable.value=mutable.value.copy(linkBusy=true,linkStatus="正在保存版本选择…")
        var resolved=false
        try {
        val a=mutable.value.archives.find {it.id==id} ?: return@launch
        val linked=a.desktop ?: return@launch
        val conflict=linked.conflicts.find {it.id==recordId} ?: return@launch
        val c=mutable.value.settings.linkConnection ?: error("请先连接电脑")
        linkClient.call(c,"groups/${linked.groupId}/resolve",kotlinx.serialization.json.buildJsonObject {
            put("recordId",kotlinx.serialization.json.JsonPrimitive(recordId));put("side",kotlinx.serialization.json.JsonPrimitive(side));put("expectedVersion",kotlinx.serialization.json.JsonPrimitive(conflict.current.version))
        });resolved=true
    }catch(e:Exception){linkFailed(e)}finally{mutable.value=mutable.value.copy(linkBusy=false)}
        if(resolved)syncDesktopNow(id)
    } }
    fun syncDesktop(id:String?=null) {scope.launch {syncDesktopNow(id)} }
    private suspend fun syncDesktopNow(id:String?=null) {
        if(mutable.value.linkBusy)return
        val connection=mutable.value.settings.linkConnection ?: return
        mutable.value=mutable.value.copy(linkBusy=true,linkStatus="正在同步…")
        try {
            val budget=linkClient.budget(connection);usage.accept(budget,connection.deviceId)
            if(budget.supported&&budget.phones.any {it.deviceId==connection.deviceId}) {
                val ledger=usage.snapshot();linkClient.call(connection,"usage",kotlinx.serialization.json.buildJsonObject {put("budgetId",kotlinx.serialization.json.JsonPrimitive(budget.budgetId));put("spentMicroCny",kotlinx.serialization.json.JsonPrimitive(ledger.spentMicroCny));put("calls",kotlinx.serialization.json.JsonPrimitive(ledger.totalCalls));put("tokens",kotlinx.serialization.json.JsonPrimitive(ledger.totalTokens))})
            }
            for(entry in mutable.value.settings.pendingLinkDeletes) {
                val parts=entry.split('/',limit=2)
                if(parts.size==2&&parts[0]!=connection.deviceId)continue
                val groupId=parts.last()
                linkClient.call(connection,"groups/$groupId/delete",kotlinx.serialization.json.buildJsonObject {})
                val settings=mutable.value.settings.copy(pendingLinkDeletes=mutable.value.settings.pendingLinkDeletes.filterNot {it==entry})
                secrets.save(settings);mutable.value=mutable.value.copy(settings=settings)
            }
            val snapshots=mutable.value.archives.filter {it.desktop?.active==true&&it.desktop.deviceId==connection.deviceId&&it.enabled&&!it.temporary&&(id==null||it.id==id)}
            for((index,snapshot) in snapshots.withIndex()) {
                mutable.value=mutable.value.copy(linkStatus="正在同步 ${snapshot.name}（${index+1}/${snapshots.size}）…")
                val (linked,profile)=linkClient.sync(connection,snapshot)
                val latest=mutable.value.archives.find {it.id==snapshot.id} ?: continue
                if(mutable.value.settings.linkConnection!=connection||latest.desktop?.groupId!=snapshot.desktop?.groupId)continue
                if(latest.messages!=snapshot.messages||latest.linkProfile()!=snapshot.linkProfile()) {
                    linkApplying=true
                    try {mutateArchive(snapshot.id){mergeLinkedHistory(snapshot,it,linked).let {next->next.copy(revision=maxOf(next.revision,it.revision+1))}}}finally{linkApplying=false}
                    linkRequested=true
                    continue
                }
                val changed=latest.copy(desktop=linked).desktopPrompt()!=latest.desktopPrompt()||linked.records.filter {it.kind in setOf("context_v2","memory_v2")||it.kind=="message"&&it.id.startsWith("desktop:")}!=latest.desktop?.records.orEmpty().filter {it.kind in setOf("context_v2","memory_v2")||it.kind=="message"&&it.id.startsWith("desktop:")}||profile!=null&&profile!=latest.linkProfile()
                linkApplying=true
                try {mutateArchive(snapshot.id) { current ->
                    val p=profile
                    val merged=mergeLinkedHistory(snapshot,current,linked)
                    merged.copy(revision=if(changed) maxOf(merged.revision,current.revision+1) else merged.revision,
                        relationship=p?.relationship ?: current.relationship,style=p?.style ?: current.style,preferences=p?.preferences ?: current.preferences,
                        memory=if(p!=null&&current.memory.consent&&p.memory.consent)current.memory.copy(profile=p.memory.profile) else current.memory)
                }} finally {linkApplying=false}
            }
            val conflicts=mutable.value.archives.filter {it.desktop?.active==true&&it.desktop.deviceId==connection.deviceId}.sumOf {it.desktop?.conflicts?.size ?: 0}
            mutable.value=mutable.value.copy(linkNeedsPairing=false,linkStatus=when {snapshots.isEmpty()->"电脑已连接，请先关联对象";linkRequested->"本次修改已保留，正在继续同步";conflicts>0->"已同步，有${conflicts}项两端修改需要选择";else->"已同步，电脑资料可离线使用"})
        }catch(e:Exception){linkFailed(e)}
        finally {mutable.value=mutable.value.copy(linkBusy=false);if(linkRequested&&linkJob?.isActive!=true&&!mutable.value.linkNeedsPairing)scheduleLinkSync()}
    }
    fun notice(text: String) { mutable.value = mutable.value.copy(notice = text, error = "") }
    fun reportError(text: String) { mutable.value = mutable.value.copy(error = text, notice = "") }
    fun selected(): ChatArchive? = mutable.value.archives.find { it.id == mutable.value.selectedArchiveId }
    fun mutateArchive(id: String, transform: (ChatArchive) -> ChatArchive) {
        update { old -> old.copy(archives = old.archives.map { if (it.id == id) transform(it) else it }) }
    }
    fun linkPersonChannel(sourceId:String,targetId:String?) {
        require(!mutable.value.busy&&!mutable.value.linkBusy){"请等待当前生成或同步完成"}
        update {it.copy(archives=PersonChannels.link(it.archives,sourceId,targetId))}
        notice(if(targetId==null)"已解除本机人物关联，原聊天保留" else "已确认是同一个人，保留各渠道原文")
    }
    fun createArchive(name: String, platform: String, temporary: Boolean = false): String {
        require(name.isNotBlank()) { "请填写档案名称" }
        val archive = ChatArchive(name = name.trim(), platform = platform.trim().ifBlank { "通用截图" }, temporary = temporary, lastUsedAt = System.currentTimeMillis())
        val previous = mutable.value.preview?.takeIf { it.archiveId != null }
        val held = previous?.let { holdWhenLeaving(it) }
        update { old -> old.copy(archives = old.archives + archive, selectedArchiveId = archive.id,
            preview = if (previous != null) PreviewSession(archiveId = archive.id, bindingConfirmed = true, heldBatches = held.orEmpty())
                else old.preview?.copy(archiveId = archive.id, bindingConfirmed = true, version = old.preview.version + 1)) }
        rememberArchive(archive.id)
        autoGenerate()
        return archive.id
    }
    fun selectArchive(id: String) {
        if (mutable.value.busy) return
        require(mutable.value.archives.any { it.id == id })
        if (mutable.value.selectedArchiveId == id) return
        val previous = mutable.value.preview
        val saved = previous?.heldBatches.orEmpty().firstOrNull { it.archiveId == id }
        val remaining = previous?.heldBatches.orEmpty().filterNot { it.id == saved?.id }
        val held = if (previous != null && previous.archiveId != null && (previous.pages.isNotEmpty() || previous.manualRows.isNotEmpty()))
            holdWhenLeaving(previous.copy(heldBatches = remaining)) else remaining
        val next = when {
            saved != null -> PreviewSession(archiveId=id,bindingConfirmed=true,pages=saved.pages,manualRows=saved.rows,instruction=saved.instruction,heldBatches=held,version=saved.version)
            previous?.archiveId == null && previous != null -> previous.copy(archiveId=id,bindingConfirmed=true,version=previous.version+1)
            previous != null -> PreviewSession(archiveId=id,bindingConfirmed=true,heldBatches=held)
            else -> null
        }
        update { it.copy(selectedArchiveId = id, captureStatus="", error="", notice="已切换对象，使用该对象的记录与草稿", archives = it.archives.map { a -> if (a.id == id) a.copy(lastUsedAt = System.currentTimeMillis()) else a }, preview=next) }
        rememberArchive(id)
        if (previous?.archiveId == null && saved == null) autoGenerate()
    }
    private fun holdWhenLeaving(preview: PreviewSession): List<HeldScreenshotBatch> {
        if (preview.pages.isEmpty() && preview.manualRows.isEmpty()) return preview.heldBatches
        require(preview.heldBatches.size < 4) { "还有4批未处理截图，请先恢复处理后再切换对象" }
        return preview.heldBatches + HeldScreenshotBatch(archiveId = preview.archiveId,pages = preview.pages,rows = preview.manualRows,instruction = preview.instruction,version=preview.version)
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
        val archive=selected()?:return false
        val draft = archive.draft ?: return false
        if(draft.contextV2?.let {MobilePipelineV2.contextCurrent(archive,it,archives=mutable.value.archives)}==false)return false
        val preview = mutable.value.preview
        return preview?.pages.isNullOrEmpty() || draft.previewVersion == preview?.version
    }
    fun closePreview() {
        if (mutable.value.busy) return
        (mutable.value.preview?.pages.orEmpty() + mutable.value.preview?.heldBatches.orEmpty().flatMap { it.pages }).forEach { File(it.path).delete() }
        update { old -> old.copy(preview = null, archives = old.archives.filterNot { it.temporary },
            selectedArchiveId = old.selectedArchiveId?.takeIf { id -> old.archives.any { it.id == id && !it.temporary } }) }
    }
    fun saveTemporary(id: String, name: String) {
        require(name.isNotBlank())
        mutateArchive(id) { it.copy(temporary = false, name = name.trim()) }
    }
    fun deleteArchive(id: String) {
        if (mutable.value.busy) return
        mutable.value.archives.find {it.id==id}?.desktop?.let { linked ->
            val settings=mutable.value.settings.copy(pendingLinkDeletes=(mutable.value.settings.pendingLinkDeletes+"${linked.deviceId}/${linked.groupId}").distinct())
            secrets.save(settings);mutable.value=mutable.value.copy(settings=settings)
        }
        val files = mutable.value.archives.find { it.id == id }?.consultation?.pages.orEmpty() + mutable.value.preview?.takeIf { it.archiveId == id }?.pages.orEmpty() +
            mutable.value.preview?.heldBatches.orEmpty().filter { it.archiveId == id }.flatMap { it.pages }
        update { old -> old.copy(archives = old.archives.filterNot { it.id == id }, selectedArchiveId = old.selectedArchiveId?.takeUnless { it == id },
            preview = old.preview?.let { p ->
                val held = p.heldBatches.filterNot { it.archiveId == id }
                if (p.archiveId == id) { if (held.isEmpty()) null else PreviewSession(heldBatches = held) }
                else p.copy(heldBatches = held)
            }, advisorArchiveId = old.advisorArchiveId?.takeUnless { it == id }) }
        files.forEach { File(it.path).delete() }
    }
    fun reviseMessages(id: String, rows: List<ChatMessage>) {
        update { state -> state.copy(archives = state.archives.map { if (it.id == id) ContextEngine.revise(it, rows) else it },
            preview = state.preview?.let { p -> if (p.archiveId != id) p else p.copy(version = p.version + 1, pages = p.pages.map { page ->
                if (page.includeVisual) page.copy(rows = rows.filter { it.sourceId == page.id }, corrected = true) else page
            }) }) }
    }
    fun repairHistory(id:String,expectedRevision:Long,rows:List<ChatMessage>){
        require(!mutable.value.busy){"请等待当前生成完成"}
        val archive=mutable.value.archives.find {it.id==id} ?: error("档案不存在")
        require(archive.revision==expectedRevision){"记录已更新，请重新预览整理结果"}
        require(ScreenshotStitcher.repair(archive.messages)==rows){"整理预览已失效，请重新打开"}
        mutateArchive(id){ContextEngine.revise(it,rows).copy(historyUndo=it.messages)}
        notice("已整理聊天记录，原记录备份和手工草稿已保留")
    }
    fun undoHistoryRepair(id:String){
        require(!mutable.value.busy){"请等待当前生成完成"}
        val archive=mutable.value.archives.find {it.id==id} ?: error("档案不存在")
        val backup=archive.historyUndo ?: error("没有可撤销的整理")
        require(archive.messages==ScreenshotStitcher.repair(backup)){"整理后记录已变化，已保留备份，不能覆盖新消息"}
        mutateArchive(id){ContextEngine.revise(it,backup).copy(historyUndo=null)}
        notice("已恢复整理前的记录")
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
            require(ModelDiagnostics.errors(settings).isEmpty()){ModelDiagnostics.errors(settings).distinct().joinToString("；")}
            models.validateEndpoint(settings.textEndpoint)
            if (settings.visionEndpoint.isNotBlank()) models.validateEndpoint(settings.visionEndpoint)
            if(listOf(settings.qualityEndpoint,settings.qualityModel,settings.qualityKey).any {it.isNotBlank()}) {require(listOf(settings.qualityEndpoint,settings.qualityModel,settings.qualityKey).all {it.isNotBlank()}) {"高档模型接口、名称和密钥请一起填写"};models.validateEndpoint(settings.qualityEndpoint)}
            require(settings.dailyCallLimit in 1..1000 && settings.dailyTokenLimit in 8192..2000000) {"每日调用上限应为1–1000次，预估token上限应为8192–2000000"}
            val saved = settings.copy(lastArchiveId = mutable.value.settings.lastArchiveId,
                screenshotUploadAccepted = settings.screenshotUploadAccepted || mutable.value.settings.screenshotUploadAccepted,
                bubbleOpacity = mutable.value.settings.bubbleOpacity, panelOpacity = mutable.value.settings.panelOpacity)
            val previous = mutable.value.settings
            secrets.save(saved)
            if (!previous.sameReplyConfiguration(saved))
                update { state -> state.copy(archives = state.archives.map { it.copy(revision = it.revision + 1) }) }
            mutable.value = mutable.value.copy(settings = saved, error = "", notice = "设置已保存到手机")
        }.onFailure { reportError(it.message ?: "无法保存设置") }
    }
    fun importImages(uris: List<Uri>, forConsultation: Boolean = false): Job? {
        val advisorId = mutable.value.advisorArchiveId.takeIf { forConsultation }
        if (advisorId != null) return launchWork("正在准备咨询截图") {
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
        return launchWork("正在准备截图") {
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
    fun addCapturedPage(page: ScreenshotPage, append: Boolean = true) {
        cancelWork()
        startPreview()
        if (!append) {
            val previous = mutable.value.preview!!
            val unfinished = previous.pages.any { !it.includeVisual } || previous.manualRows.isNotEmpty()
            if (unfinished && previous.heldBatches.size >= 4) {
                File(page.path).delete(); reportError("还有4批未处理截图，请在更多中恢复处理后再截新一轮"); return
            }
            val held = if (unfinished) previous.heldBatches + HeldScreenshotBatch(archiveId = previous.archiveId,
                pages = previous.pages, rows = previous.manualRows, instruction = previous.instruction,version=previous.version) else previous.heldBatches
            update { state -> state.copy(captureStatus="", preview = PreviewSession(archiveId = state.selectedArchiveId, bindingConfirmed = state.selectedArchiveId != null, heldBatches = held)) }
            if (!unfinished) previous.pages.forEach { File(it.path).delete() }
        }
        if (mutable.value.preview!!.pages.size >= 8) { File(page.path).delete(); reportError("一次最多8张截图"); return }
        updatePreview { it.copy(pages = it.pages + page) }
        autoGenerate()
    }
    fun restoreCaptureBatch(id: String) {
        if (mutable.value.busy) return
        val current = mutable.value.preview ?: return
        val held = current.heldBatches.find { it.id == id } ?: return
        require(held.archiveId == null || mutable.value.archives.any { it.id == held.archiveId && it.enabled }) { "原聊天档案已不可用" }
        val unfinished = current.pages.any { !it.includeVisual } || current.manualRows.isNotEmpty()
        val remaining = current.heldBatches.filterNot { it.id == id } + if (unfinished) listOf(HeldScreenshotBatch(
            archiveId = current.archiveId, pages = current.pages, rows = current.manualRows, instruction = current.instruction,version=current.version)) else emptyList()
        update { it.copy(selectedArchiveId = held.archiveId, preview = PreviewSession(archiveId = held.archiveId,
            bindingConfirmed = held.archiveId != null, pages = held.pages, manualRows = held.rows, instruction = held.instruction, heldBatches = remaining,version=held.version)) }
        if (!unfinished) current.pages.forEach { File(it.path).delete() }
        held.archiveId?.let { rememberArchive(it) }
        notice("已恢复旧截图及原对象，手工回复保留")
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
        mutateArchive(archive.id) { it.copy(draft = it.draft?.let { d -> d.copy(text = text, state = DraftState.EDITING,
            manuallyEdited = true, editedAlternatives = d.editedAlternatives + (d.selected to text)) }) }
    } }
    fun chooseAlternative(index: Int) { selected()?.let { archive ->
        if (archive.draft?.state in setOf(DraftState.SUBMITTING, DraftState.SUBMITTED, DraftState.UNKNOWN, DraftState.SENT)) return
        mutateArchive(archive.id) { it.copy(draftHistory = Personalization.rememberDraft(it), draft = it.draft?.selectAlternative(index)) }
    } }
    fun generate(instruction: String, automatic: Boolean = false) = launchWork("正在整理上下文",selected()?.id,instruction) {
        val requestSettings = mutable.value.settings
        require(!requestSettings.paused) { "辅助已暂停，请先在设置恢复" }
        var archive = selected() ?: error("请先选择或新建聊天档案")
        if(automatic && archive.draft?.manuallyEdited == true) return@launchWork
        require(archive.draft?.state !in setOf(DraftState.SUBMITTING,DraftState.SUBMITTED,DraftState.UNKNOWN)) { "请先核对上次发送结果" }
        markReplyPhase(archive.id,"context",instruction)
        val requestInstruction = if(!automatic && draftIsCurrent() && archive.draft?.state != DraftState.SENT)
            instruction + "\n本人尚未发送的改写参考：\n" + archive.draft?.text.orEmpty().take(2000) else instruction
        fun unchanged(snapshot:ChatArchive,preview:PreviewSession?) {
            val latest=mutable.value.archives.find {it.id==snapshot.id} ?: error("档案已删除")
            require(latest.revision==snapshot.revision && latest.messages==snapshot.messages && latest.draft==snapshot.draft && latest.skill==snapshot.skill && latest.memory==snapshot.memory && latest.preferences==snapshot.preferences && mutable.value.settings.sameReplyConfiguration(requestSettings) && mutable.value.selectedArchiveId==snapshot.id && mutable.value.preview==preview) {
                "有新消息、记忆、截图或草稿修改，旧结果未采用；请重新生成"
            }
        }
        val preview=mutable.value.preview
        if(preview!=null) {
            require(preview.archiveId==archive.id && preview.bindingConfirmed) {"请先确认截图属于当前对象"}
            val snapshot=archive
            val unresolved=preview.pages.filterNot {it.corrected}
            var recognized=emptyList<cn.replyassistant.ai.VisualPage>()
            if(unresolved.isNotEmpty()) {
                require(requestSettings.screenshotUploadAccepted) {"请先同意将截图发送到你配置的多模态模型"}
                mutable.value=mutable.value.copy(workLabel="正在识别聊天记录")
                markReplyPhase(archive.id,"recognition",instruction)
                val result=models.screenshotReply(snapshot,unresolved,emptyList(),"",requestSettings,recognitionOnly=true)
                unchanged(snapshot,preview)
                require(!result.contactMismatch) {result.note.ifBlank {"截图可能属于其他对象，请核对"}}
                require(!result.needsMoreContext) {result.note.ifBlank {"截图内容不足，请补图或纠正"}}
                recognized=result.pages
            }
            val pages=preview.pages.map {page ->
                if(page.corrected) page else {
                    val r=recognized.first {it.sourceId==page.id}
                    val rows=r.messages.map {m->ChatMessage(speaker=m.speaker,text=m.text.trim(),uncertain=m.uncertain||m.speaker==Speaker.UNKNOWN,
                        origin=if(page.accessibleText.isBlank())Origin.SCREENSHOT else Origin.ACCESSIBILITY,sourceId=page.id,
                        generated=m.speaker==Speaker.ME&&((listOfNotNull(snapshot.draft)+snapshot.draftHistory).any {d->m.text.trim()==d.text.trim()||m.text.trim() in d.alternatives.map(String::trim)}||snapshot.messages.any {it.generated&&it.text.trim()==m.text.trim()}))}
                    page.copy(rows=rows,corrected=true,includeVisual=true,imageDescription=r.imageDescription.trim())
                }
            }
            val ids=pages.map {it.id}.toSet()+preview.manualRows.map {it.sourceId}
            var merged=archive.copy(messages=archive.messages.filterNot {it.sourceId in ids})
            pages.forEach {page->
                val rows=if(page.imageDescription.isNotBlank()&&page.rows.none {it.text.contains(page.imageDescription)}) page.rows+ChatMessage(speaker=Speaker.UNKNOWN,
                    text="[图片内容，发言归属不确定] ${page.imageDescription}",uncertain=true,origin=Origin.SCREENSHOT,sourceId=page.id) else page.rows
                merged=ContextEngine.append(merged,rows,observeDraft=false)
            }
            merged=ContextEngine.append(merged,preview.manualRows,observeDraft=false)
            merged=merged.copy(revision=snapshot.revision+1,summaries=ContextEngine.summarize(merged.messages),memory=Personalization.invalidateMemory(snapshot,merged.messages))
            archive=merged
            update {state->state.copy(archives=state.archives.map {if(it.id==merged.id)merged else it},preview=preview.copy(pages=pages),captureStatus="已保存本轮识别文字，失败重试不重复识图")}
        }
        val snapshot=archive
        val requestPreview=mutable.value.preview
        val contextV2=MobilePipelineV2.build(snapshot,requestInstruction,archives=mutable.value.archives)
        mutable.value=mutable.value.copy(workLabel="正在判断如何回应")
        markReplyPhase(snapshot.id,"decision",instruction)
        val decision=models.decideV2(contextV2,requestInstruction,requestSettings)
        unchanged(snapshot,requestPreview)
        require(MobilePipelineV2.contextCurrent(selected()?:snapshot,contextV2,archives=mutable.value.archives)) {"人物关联或长期记忆已更新，请重新生成"}
        if(decision.action!="reply") {
            mutateArchive(snapshot.id) {it.copy(revision=it.revision+1,lastDecisionV2=decision,pending=decision.action=="ask_user")}
            notice(when(decision.action){"wait"->"对方还没说完，暂不生成";"skip"->"对方明确要求停止联系，本轮不生成";else->"必要资料不足，请补充个人事实后生成"})
            markReplyPhase(snapshot.id,if(decision.action=="ask_user")"needs_context" else "no_reply",instruction)
            return@launchWork
        }
        val skillContent=if(snapshot.skill.enabled)withContext(Dispatchers.IO){skills.payload(requestInstruction+contextV2.recentMessages.joinToString("\n"){it.text})}else ""
        mutable.value=mutable.value.copy(workLabel=if(decision.risk_level=="high"&&requestSettings.qualityKey.isNotBlank())"正在使用高档模型起草三条候选" else "正在起草三条候选")
        markReplyPhase(snapshot.id,"generation",instruction)
        val result=models.generateV2(contextV2,decision,snapshot,requestInstruction,requestSettings,skillContent)
        unchanged(snapshot,requestPreview)
        if(snapshot.skill.enabled)require(result.advisor!=null){"军师分析缺失，资料已保留，请重试"}
        require(MobilePipelineV2.contextCurrent(selected()?:snapshot,contextV2,archives=mutable.value.archives)) {"生成期间人物关联或长期记忆已更新，候选未采用，请重新生成"}
        markReplyPhase(snapshot.id,"quality",instruction)
        val quality=result.alternatives.map {MobilePipelineV2.quality(contextV2,decision,it)}
        mutateArchive(snapshot.id) {existing ->
            val sources=existing.messages.filter {!it.uncertain&&!it.orderUncertain&&it.speaker!=Speaker.UNKNOWN}.flatMap {listOf(it.id,it.sourceId)+it.sourceRefs}.toSet()-existing.messages.filter {it.uncertain||it.orderUncertain}.flatMap {listOf(it.sourceId)+it.sourceRefs}.toSet()
            val next=Personalization.applyMemory(existing,result.memorySuggestions,sources,emptySet())
            next.copy(draftHistory=Personalization.rememberDraft(existing),lastDecisionV2=decision,draft=ReplyDraft(contextRevision=existing.revision,alternatives=result.alternatives,
                instruction=instruction,note=result.note,uncertain=result.uncertain||contextV2.recentMessages.any {it.uncertain||it.orderUncertain},advisor=result.advisor,
                alternativeLabels=result.alternativeLabels,previewVersion=requestPreview?.version,contextV2=contextV2,decisionV2=decision,qualityV2=quality,generationModel=models.generationModelV2(decision,requestSettings)))
        }
        notice(if(quality.any {it.status=="blocked"})"三条候选已生成，含需修改的内容；检查通过后可复制" else "三条候选已在手机生成，请选择、核对并复制")
        markReplyPhase(snapshot.id,"completed",instruction)
    }
    fun copyDraft() {
        val archive = selected() ?: return
        require(ContextEngine.canAct(archive) && draftIsCurrent()) { "上下文已更新或该回复已处理，请重新检查" }
        val text = archive.draft!!.text
        (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("回复", text))
        mutateArchive(archive.id) { it.copy(draft = it.draft?.copy(state = DraftState.COPIED)) }
        notice("已复制，尚未标记为发送")
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
        require(archive.draft?.contextV2==null) {"独立流程的资料已更新，请重新生成，不能直接复用旧决策"}
        require(archive.draft != null && archive.draft.state !in setOf(DraftState.SUBMITTING, DraftState.SUBMITTED, DraftState.UNKNOWN, DraftState.SENT))
        mutateArchive(archive.id) { it.copy(draft = it.draft?.copy(contextRevision = it.revision, previewVersion = mutable.value.preview?.version)) }
        notice("已记录你核对最新上下文，草稿仍未发送")
    } }
    fun dismissPending() { selected()?.let { archive -> mutateArchive(archive.id) { it.copy(pending = false) }; notice("本轮暂不回复，后续新消息仍会提示") } }
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
        if(mutable.value.busy) return
        val layout = ChatAccessibilityService.readLayout() ?: run { reportError("未读取到聊天文字，请检查无障碍权限，或改用截屏"); return }
        addCapturedPage(ScreenshotPage(path="",rows=emptyList(),accessibleText=layout),append=false)
    }

    fun openAdvisor(id: String) {
        require(!mutable.value.busy) { "请等待当前请求完成" }
        require(mutable.value.archives.any { it.id == id && it.enabled })
        mutable.value = mutable.value.copy(advisorArchiveId = id)
    }
    fun openHistory(id:String) {
        require(mutable.value.archives.any {it.id==id&&it.enabled}) {"档案不存在"}
        mutable.value=mutable.value.copy(historyArchiveId=id,advisorArchiveId=null)
        desktopForeground()
    }
    fun closeHistory(){mutable.value=mutable.value.copy(historyArchiveId=null)}
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
    fun consult(id: String) = launchWork("正在分析问题") {
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
        val certain = snapshot.messages.filter { !it.uncertain && !it.orderUncertain && it.speaker != Speaker.UNKNOWN }.flatMap { listOf(it.id,it.sourceId)+it.sourceRefs }.toSet() -
            snapshot.messages.filter { it.uncertain||it.orderUncertain }.flatMap {listOf(it.sourceId)+it.sourceRefs}.toSet() + result.pages.filter { p -> p.messages.isNotEmpty() && p.messages.none { it.uncertain || it.speaker == Speaker.UNKNOWN } }.map { it.sourceId }
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

    fun cancelGeneration() { cancelWork(); mutable.value = mutable.value.copy(generationCancelled = true); notice("已取消，本轮内容和原回复已保留") }
    fun retryReply(){val archive=selected() ?: return;generate(archive.replyAttempt?.instruction ?: archive.draft?.instruction.orEmpty())}
    private fun markReplyPhase(id:String,phase:String,instruction:String,error:String=""){mutateArchive(id){it.copy(replyAttempt=ReplyAttempt(phase,instruction,error,it.replyAttempt?.takeIf {a->a.phase in replyRunningPhases}?.startedAt ?: System.currentTimeMillis()))}}
    private fun cancelWork() { workArchiveId?.let {id->mutable.value.archives.find {it.id==id}?.replyAttempt?.takeIf {it.phase in replyRunningPhases}?.let {markReplyPhase(id,"cancelled",it.instruction)}};workVersion++; work?.cancel(); work = null;workArchiveId=null; mutable.value = mutable.value.copy(busy = false, workLabel = "", workStartedAt = 0) }
    private fun launchWork(label: String = "正在处理内容",replyTargetId:String?=null,replyInstruction:String="", block: suspend () -> Unit): Job? {
        if (mutable.value.busy) return null
        mutable.value = mutable.value.copy(busy = true, error = "", notice = "", workLabel = label,
            workStartedAt = android.os.SystemClock.elapsedRealtime(), generationCancelled = false)
        val version = ++workVersion
        workArchiveId=replyTargetId
        return scope.launch(start = CoroutineStart.LAZY) {
            try { block() } catch (e: CancellationException) { throw e }
            catch (e: Exception) { if(version==workVersion){val message=e.message?.take(240) ?: "操作失败，原有内容已保留";replyTargetId?.let {markReplyPhase(it,"failed",replyInstruction,message)};reportError(message)} }
            finally { if (version == workVersion){workArchiveId=null;mutable.value = mutable.value.copy(busy = false, workLabel = "", workStartedAt = 0)} }
        }.also { work = it; it.start() }
    }
}
