package cn.replyassistant.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.background
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cn.replyassistant.data.AssistantController
import cn.replyassistant.domain.*
import kotlinx.coroutines.delay

@Composable private fun GenerationProgress(state: AssistantState, controller: AssistantController) {
    var seconds by remember(state.workStartedAt) { mutableLongStateOf(0) }
    LaunchedEffect(state.workStartedAt) {
        while (true) { seconds = (android.os.SystemClock.elapsedRealtime() - state.workStartedAt) / 1000; delay(1000) }
    }
    LinearProgressIndicator(Modifier.fillMaxWidth())
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text("${state.workLabel} · ${seconds}秒", Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
        TextButton(onClick = controller::cancelGeneration) { Text("取消生成") }
    }
}

@OptIn(ExperimentalFoundationApi::class, ExperimentalLayoutApi::class)
@Composable fun ReplyPanel(controller: AssistantController, compact: Boolean = false, onClose: () -> Unit, onPick: (() -> Unit)? = null, onCapture: (() -> Unit)? = null, onAppendCapture: (() -> Unit)? = null, onAdvisor: ((String) -> Unit)? = null, onHistory: ((String) -> Unit)? = null, onLink: ((String) -> Unit)? = null, onResize: ((Float) -> Unit)? = null) {
    val state by controller.state.collectAsStateWithLifecycle()
    if(state.historyArchiveId!=null){HistoryScreen(controller);return}
    if (state.advisorArchiveId != null) { AdvisorScreen(controller,onPick); return }
    val archive = state.archives.find { it.id == state.selectedArchiveId }
    val panelId = archive?.id ?: "unbound"
    val savedPosition = remember(panelId) { controller.panelPosition(panelId) }
    val listState = remember(panelId) { LazyListState(savedPosition.index, savedPosition.offset) }
    LaunchedEffect(panelId, listState) {
        snapshotFlow { listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset }.collect { (index, offset) ->
            controller.savePanelPosition(panelId, controller.panelPosition(panelId).copy(index = index, offset = offset))
        }
    }
    val focus = LocalFocusManager.current
    val keyboardVisible = WindowInsets.isImeVisible
    var preference by remember { mutableStateOf(false) }
    var correction by remember { mutableStateOf(false) }
    var correctionText by remember { mutableStateOf("") }
    var analysis by remember { mutableStateOf(false) }
    var oldDrafts by remember { mutableStateOf(false) }
    var samples by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var contactSearch by remember { mutableStateOf("") }
    var create by remember { mutableStateOf(false) }
    var details by remember { mutableStateOf(false) }
    var manual by remember { mutableStateOf(false) }
    var history by remember { mutableStateOf(false) }
    var more by remember(panelId) { mutableStateOf(savedPosition.more) }
    var editing by remember(panelId) { mutableStateOf(savedPosition.editing) }
    var recent by remember(panelId) { mutableStateOf(savedPosition.recent) }
    var rewrite by remember(panelId) { mutableStateOf(savedPosition.rewrite) }
    var newName by remember { mutableStateOf("") }
    var instruction by remember(archive?.id, state.preview?.id) { mutableStateOf(
        savedPosition.instruction?.takeIf { savedPosition.previewId == state.preview?.id }
            ?: state.preview?.instruction ?: archive?.draft?.instruction.orEmpty()) }
    SideEffect { controller.savePanelPosition(panelId, ReplyPanelPosition(listState.firstVisibleItemIndex,
        listState.firstVisibleItemScrollOffset, editing, more, recent, rewrite, state.preview?.id, instruction)) }
    Surface(shape = RoundedCornerShape(24.dp), tonalElevation = 3.dp) {
        Column(Modifier.fillMaxSize().imePadding().padding(horizontal = if (compact) 14.dp else 20.dp)) {
                Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(top = 8.dp)) {
                if (onResize != null) Box(Modifier.fillMaxWidth().height(18.dp)
                    .semantics { contentDescription = "拖动调整面板高度" }
                    .pointerInput(onResize) { detectVerticalDragGestures { change, delta -> change.consume(); onResize(delta) } },
                    contentAlignment = Alignment.Center) { HorizontalDivider(Modifier.width(44.dp), thickness = 4.dp) }
                if (!compact) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("辅助回复", style = MaterialTheme.typography.titleLarge)
                    TextButton(onClick = { if (!compact) controller.closePreview(); onClose() }, enabled = compact || !state.busy) { Text(if (compact) "收起" else "完成") }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(Modifier.weight(1f)) {
                    OutlinedButton(onClick = { menu = true }, enabled = !state.busy,
                        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
                        modifier = Modifier.widthIn(max = 180.dp).semantics { contentDescription = "聊天对象：${archive?.name ?: "首次选择"}" }) {
                        Text("${archive?.name ?: "选择对象"} ▾", maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        OutlinedTextField(contactSearch,{ contactSearch = it },label = { Text("搜索对象") },singleLine = true,modifier = Modifier.width(280.dp).padding(8.dp))
                        state.archives.filter { it.enabled && (contactSearch.isBlank() || (it.name + " " + it.platform).contains(contactSearch,true)) }
                            .sortedByDescending { if (it.lastUsedAt > 0) it.lastUsedAt else it.updatedAt }.forEach { candidate -> DropdownMenuItem(text = { Text("${candidate.name} · ${candidate.platform}") },
                            onClick = { controller.selectArchive(candidate.id); menu = false; contactSearch = "" }) }
                        DropdownMenuItem(text = { Text("新建聊天对象") }, onClick = { menu = false; create = true })
                    }
                }
                if(archive!=null)TextButton(onClick={recent=!recent}){Text(if(recent) "收起记录" else "记录")}
                if (compact) TextButton(onClick = { focus.clearFocus(); onClose() }) { Text("收起") }
                }
                if (!keyboardVisible) Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                    if (onCapture != null) Button(onClick = onCapture, enabled = !state.busy) { Text("截屏") }
                    OutlinedButton(onClick={safe(controller){controller.readCurrentChat()}},enabled=!state.busy) { Text("读取聊天") }
                }
                if (archive != null) Text(buildString {
                    append(archive.platform)
                    if (state.captureStatus.isNotBlank()) append(" · ${state.captureStatus}")
                    else if (!state.preview?.pages.isNullOrEmpty()) append(" · 本轮 ${state.preview!!.pages.size} 页")
                    archive.desktop?.lastSyncedAt?.takeIf { it > 0 }?.let { append(" · 同步 ${java.text.SimpleDateFormat("HH:mm",java.util.Locale.CHINA).format(java.util.Date(it))}") }
                }, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (archive != null && !recent && !keyboardVisible) {
                    val last = remember(archive.messages, archive.desktop?.records) { archive.chatHistory().lastOrNull() }
                    last?.let { TextButton(onClick = { recent = true }, contentPadding = PaddingValues(vertical = 0.dp)) {
                        Text("${ContextEngine.speakerLabel(it.message.speaker)}：${it.message.text}", maxLines = 1, overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.bodySmall)
                    } }
                }
                if (state.busy) GenerationProgress(state, controller)
                }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = listState, verticalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = PaddingValues(top = 8.dp, bottom = 16.dp)) {
            item {
                if(archive!=null&&more)TextButton(onClick={if(onLink!=null)onLink(archive.id) else controller.openLink(archive.id)}) {Text("电脑资料 / 同步")}
                if (archive != null && more) Row {
                    Text("军师：${if (archive.skill.enabled) "已启用" else "未启用"}", Modifier.weight(1f).padding(top = 12.dp))
                    TextButton(onClick = { safe(controller) { if (onAdvisor != null) onAdvisor(archive.id) else controller.openAdvisor(archive.id) } },enabled = !state.busy) { Text("问军师") }
                }
                if (state.error.isNotBlank()) {
                    Tip(state.error, true)
                }
                archive?.replyAttempt?.takeIf {it.phase in setOf("failed","cancelled","interrupted")}?.let {attempt->
                    if(state.error.isBlank()&&attempt.error.isNotBlank())Tip(attempt.error,true)
                    TextButton(onClick=controller::retryReply,enabled=!state.busy&&!state.settings.paused) {Text("重试上次生成")}
                }
                if(archive?.replyAttempt==null && (state.error.isNotBlank() || state.generationCancelled)) TextButton(onClick={controller.generate(instruction)},enabled=!state.busy&&!state.settings.paused) {Text("重试")}
                if (state.notice.isNotBlank() && !state.busy && (more || state.error.isNotBlank() || !state.notice.contains("已生成"))) Tip(state.notice)
            }
            if(recent && archive!=null) item { Block("最近聊天") {
                val rows=archive.chatHistory().takeLast(6)
                if(rows.isEmpty()) Text("还没有保存聊天记录，可读取聊天或截屏补充。")
                rows.forEach { row -> Text("${ContextEngine.speakerLabel(row.message.speaker)}：${row.message.text}" + if(row.message.uncertain||row.message.orderUncertain) "（待确认）" else "") }
                TextButton(onClick={safe(controller){if(onHistory!=null)onHistory(archive.id) else controller.openHistory(archive.id)}}){Text("查看全部")}
            } }
            if (archive == null) item { Block("首次选择聊天对象，以后沿用") {
                state.archives.filter { it.enabled }.forEach { existing -> TextButton(onClick = { controller.selectArchive(existing.id) }) { Text("${existing.name} · ${existing.platform}") } }
                OutlinedTextField(newName, { newName = it }, label = { Text("对方名称") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Button(onClick = { safe(controller) { controller.createArchive(newName, "通用截图") } }, enabled = newName.isNotBlank()) { Text("选定并继续") }
            } }
            if (!state.preview?.pages.isNullOrEmpty() && !state.settings.screenshotUploadAccepted) item { Block("直接看图回复") {
                Text("截图或你主动读取的当前聊天界面内容将发送到配置的模型服务，用于理解对话和生成回复。无需逐条核对。")
                Button(onClick = controller::acceptScreenshotUpload, enabled = !state.busy) { Text("同意并继续") }
            } }
            archive?.draft?.let { draft -> item { Block("回复建议", compact) {
                val locked = draft.state in setOf(DraftState.SUBMITTING, DraftState.SUBMITTED, DraftState.UNKNOWN, DraftState.SENT)
                val canAct = ContextEngine.canAct(archive) && controller.draftIsCurrent() && !state.busy && !state.settings.paused
                val stale = draft.contextRevision != archive.revision || !controller.draftIsCurrent()
                if (stale) {
                    Tip("有新内容，原草稿已保留。重新生成或核对后继续使用。", true)
                    if (!locked && draft.contextV2==null) TextButton(onClick = { safe(controller) { controller.reviewDraft() } }, enabled = !state.busy) { Text("我已核对，保留此草稿") }
                }
                if(draft.contextV2!=null&&draft.decisionV2!=null) {
                    val check=MobilePipelineV2.quality(draft.contextV2,draft.decisionV2,draft.text)
                    if(check.status=="blocked") Tip("当前候选有未经确认的事实、敏感内容或表达问题，请编辑后再复制",true)
                    else if(check.status=="review_required") Tip("本轮涉及复杂或敏感对话，请仔细核对后复制")
                    if(more) {draft.explanation().forEach {Tip(it)}}
                }
                if (draft.note.isNotBlank() && (draft.uncertain || more || draft.note.contains("尚未配置高档模型"))) Tip(draft.note, draft.uncertain)
                draft.alternatives.take(3).forEachIndexed { index, candidate ->
                    val selected = draft.selected == index
                    Surface(onClick = { safe(controller) { if(!selected)controller.chooseAlternative(index); editing=true } }, enabled = !state.busy && !locked,
                        shape = RoundedCornerShape(12.dp), color = if (selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surface,
                        modifier = Modifier.fillMaxWidth().semantics { contentDescription = "回复选项${index + 1}${if (selected) "，已选" else ""}" }) {
                        Row(Modifier.padding(horizontal = 12.dp, vertical = 9.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Text("${index + 1}", style = MaterialTheme.typography.labelLarge)
                            Column(Modifier.weight(1f)) {
                            draft.alternativeLabels.getOrNull(index)?.let { Text(it, style = MaterialTheme.typography.labelMedium,
                                maxLines = 1, overflow = TextOverflow.Ellipsis) }
                            if (selected && editing) OutlinedTextField(draft.text,controller::editDraft,label = { Text("回复（可修改）") },
                                minLines = 1,maxLines = if (compact) 4 else 8,modifier = Modifier.fillMaxWidth(),enabled = !locked && !state.busy,
                                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                                keyboardActions = KeyboardActions(onDone = { focus.clearFocus(); editing = false }))
                            else Text(if (selected) draft.text else draft.editedAlternatives[index] ?: candidate, maxLines = Int.MAX_VALUE,
                                overflow = TextOverflow.Ellipsis,style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                    }
                }
            } }
            item {
                val locked = draft.state in setOf(DraftState.SUBMITTING, DraftState.SUBMITTED, DraftState.UNKNOWN, DraftState.SENT)
                val canAct = ContextEngine.canAct(archive) && controller.draftIsCurrent() && !state.busy && !state.settings.paused
                if(!locked) {
                    Row(horizontalArrangement=Arrangement.spacedBy(4.dp)) {
                        TextButton(onClick={safe(controller){controller.feedback("太长了")}},enabled=!state.busy) {Text("短一点")}
                        TextButton(onClick={safe(controller){controller.feedback("语气不对")}},enabled=!state.busy) {Text("自然一点")}
                        TextButton(onClick={rewrite=!rewrite},enabled=!state.busy) {Text("重写")}
                    }
                    if(rewrite) Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(6.dp)) {
                        OutlinedTextField(instruction,{instruction=it;controller.setInstruction(it)},label={Text("重写要求")},maxLines=2,modifier=Modifier.weight(1f),enabled=!state.busy)
                        TextButton(onClick={controller.generate(instruction)},enabled=!state.busy&&!state.settings.paused) {Text("按此重写")}
                    }
                    archive.draftHistory.lastOrNull()?.let {old->TextButton(onClick={safe(controller){controller.restoreDraft(old.id)}},enabled=!state.busy) {Text("恢复旧稿")}}
                }
                if (more && !locked) {
                    Row {
                        listOf("太长了","不像我").forEach { kind -> TextButton(onClick = { safe(controller) { controller.feedback(kind) } },enabled = !state.busy) { Text(kind) } }
                    }
                    Row {
                        TextButton(onClick = { safe(controller) { controller.feedback("语气不对") } },enabled = !state.busy) { Text("语气不对") }
                        TextButton(onClick = { correction = true },enabled = !state.busy) { Text("事实不对") }
                    }
                }
                if (more) TextButton(onClick = { preference = true },enabled = !state.busy) { Text("记住这个偏好 / 管理偏好") }
                if (more && archive.skill.enabled && draft.advisor != null) {
                    TextButton(onClick = { analysis = !analysis }) { Text(if (analysis) "收起军师分析" else "军师分析与下一步") }
                    if (analysis) AnalysisView(draft.advisor)
                }
                if (more) Tip("每次生成三条候选，选择并复制后，由你在原聊天粘贴和发送。")
                if (draft.state in setOf(DraftState.SUBMITTED, DraftState.UNKNOWN)) Tip("上次发送结果尚未核对，不会自动重试", true)
                if (more || draft.state in setOf(DraftState.SUBMITTED, DraftState.UNKNOWN)) TextButton(onClick = { safe(controller) { controller.acknowledgeSent() } }, enabled = !state.busy && draft.state != DraftState.SENT && (canAct || draft.state in setOf(DraftState.SUBMITTED, DraftState.UNKNOWN))) {
                    Text(if (draft.state == DraftState.SENT) "已记录发送" else "我已发送")
                }
                if (draft.state in setOf(DraftState.SUBMITTED, DraftState.UNKNOWN)) TextButton(onClick = { safe(controller) { controller.acknowledgeNotSent() } }) { Text("已核对，没有发出") }
            } }
            if (archive != null && (more || archive.draft == null || state.error.isNotBlank())) item {
                OutlinedTextField(instruction, { instruction = it; controller.setInstruction(it) }, label = { Text("想怎么回（可选）") }, placeholder = { Text("简短一点、委婉拒绝…") }, modifier = Modifier.fillMaxWidth(), maxLines = 3)
                Button(onClick = { controller.generate(instruction) }, enabled = !state.busy && !state.settings.paused &&
                    (state.preview?.pages.isNullOrEmpty() || state.settings.screenshotUploadAccepted), modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) {
                    Text(if (archive.draft == null) "重试生成" else "重新生成")
                }
            }
            if (more) state.preview?.heldBatches.orEmpty().forEach { held -> item(key = held.id) {
                val owner = state.archives.find { it.id == held.archiveId }?.name ?: "未选择对象"
                TextButton(onClick = { safe(controller) { controller.restoreCaptureBatch(held.id) } },enabled = !state.busy) {
                    Text("恢复旧截图 · $owner · ${held.pages.size}张")
                }
            } }
            if (more && archive != null && archive.draftHistory.isNotEmpty()) item {
                TextButton(onClick = { oldDrafts = !oldDrafts }) { Text("历史手工草稿") }
                if (oldDrafts) archive.draftHistory.asReversed().forEach { old ->
                    Text(old.text)
                    TextButton(onClick = { safe(controller) { controller.restoreDraft(old.id) } },enabled = !state.busy) { Text("恢复此稿") }
                }
            }
            if (more) item { TextButton(onClick = { details = !details }) { Text(if (details) "收起补充／纠正" else "补充／纠正") } }
            if (more && details) {
                if (archive != null) item {
                    TextButton(onClick = { samples = !samples }) { Text("我的表达样例 · ${Personalization.samples(archive).size}条") }
                    if (samples) {
                        Tip("只标记你自己的真实发言。AI生成或不确定的内容不能用于学习。")
                        archive.messages.filter { it.speaker == Speaker.ME && !it.generated && !it.uncertain }.forEach { row ->
                            Text(row.text)
                            Row { Checkbox(row.styleExample,{ safe(controller) { controller.teachSample(row.id,it) } },enabled = !state.busy); Text("我的表达样例",Modifier.padding(top = 12.dp)) }
                        }
                    }
                }
                item { Row {
                    if (onPick != null) TextButton(onClick = onPick, enabled = !state.busy) { Text("追加截图") }
                    TextButton(onClick = { controller.startPreview(); manual = true }, enabled = !state.busy) { Text("补充文字") }
                    if (archive != null) TextButton(onClick = { history = true }) { Text("聊天原文") }
                } }
                state.preview?.let { preview ->
                    preview.pages.forEachIndexed { index, page -> item(key = page.id) { PagePreview(page, index, preview.pages.size, controller, state.busy) } }
                    preview.manualRows.forEach { row -> item(key = row.id) { MessageEditor(row, state.busy,
                        onChange = { next -> controller.updatePreview { it.copy(manualRows = it.manualRows.map { old -> if (old.id == row.id) next else old }) } },
                        onDelete = { controller.updatePreview { it.copy(manualRows = it.manualRows.filterNot { old -> old.id == row.id }) } }) } }
                }
                item { TextButton(onClick = { controller.closePreview(); onClose() }, enabled = !state.busy) { Text("结束本次，清除原始截图") } }
                if (archive?.temporary == true) item {
                    Tip("这是临时聊天，完成时会丢弃；需要留存可先保存。")
                    TextButton(onClick = { controller.saveTemporary(archive.id, archive.name) }) { Text("保存为聊天档案") }
                }
            }
        }
        archive?.draft?.let { draft ->
            val locked = draft.state in setOf(DraftState.SUBMITTING,DraftState.SUBMITTED,DraftState.UNKNOWN,DraftState.SENT)
            val canAct = ContextEngine.canAct(archive) && controller.draftIsCurrent() && !state.busy && !state.settings.paused
            Row(Modifier.fillMaxWidth(),horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { safe(controller) { controller.copyDraft(); focus.clearFocus(); if(state.settings.collapseAfterAction)onClose() } },enabled = canAct) { Text("复制") }
                TextButton(onClick = { editing = !editing; if(!editing)focus.clearFocus() },enabled = !state.busy && !locked) { Text(if (editing) "完成编辑" else "编辑") }
            }
        }
        Row(Modifier.fillMaxWidth(),horizontalArrangement = Arrangement.SpaceBetween) {
            TextButton(onClick = { more = !more }) { Text(if (more) "收起更多" else "更多") }
            if (onAppendCapture != null && !state.preview?.pages.isNullOrEmpty()) TextButton(onClick = onAppendCapture,enabled = !state.busy) { Text("补充前文") }
        }
        }
    }
    if (preference) PreferenceDialog(controller) { preference = false }
    if (correction) AlertDialog(onDismissRequest = { correction = false },title = { Text("纠正事实") },text = {
        OutlinedTextField(correctionText,{ correctionText = it },label = { Text("正确情况是什么？") },minLines = 3)
    },confirmButton = { TextButton(onClick = { safe(controller) { controller.feedback("事实不对",correctionText); correction = false; correctionText = "" } },enabled = correctionText.isNotBlank()) { Text("按此重写") } },dismissButton = { TextButton(onClick = { correction = false }) { Text("取消") } })
    if (create) NewArchiveDialog(onDismiss = { create = false }, onCreate = { name, platform, temporary -> safe(controller) {
        controller.createArchive(name, platform, temporary); create = false
    } })
    if (manual) ManualMessageDialog(onDismiss = { manual = false }, onAdd = { speaker, text ->
        controller.updatePreview { it.copy(manualRows = it.manualRows + ChatMessage(speaker = speaker, text = text)) }; manual = false
    })
    if (history && archive != null) HistoryDialog(archive, controller, onDismiss = { history = false })
}
