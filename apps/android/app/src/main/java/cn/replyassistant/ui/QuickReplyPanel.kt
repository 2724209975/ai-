package cn.replyassistant.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.background
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cn.replyassistant.data.AssistantController
import cn.replyassistant.domain.*
import cn.replyassistant.platform.NotificationReplies

@OptIn(ExperimentalFoundationApi::class)
@Composable fun ReplyPanel(controller: AssistantController, compact: Boolean = false, onClose: () -> Unit, onPick: (() -> Unit)? = null, onCapture: (() -> Unit)? = null) {
    val state by controller.state.collectAsStateWithLifecycle()
    if (state.advisorArchiveId != null) { AdvisorScreen(controller,onPick); return }
    val archive = state.archives.find { it.id == state.selectedArchiveId }
    var preference by remember { mutableStateOf(false) }
    var correction by remember { mutableStateOf(false) }
    var correctionText by remember { mutableStateOf("") }
    var analysis by remember { mutableStateOf(false) }
    var oldDrafts by remember { mutableStateOf(false) }
    var samples by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var create by remember { mutableStateOf(false) }
    var details by remember { mutableStateOf(false) }
    var manual by remember { mutableStateOf(false) }
    var history by remember { mutableStateOf(false) }
    var more by remember(archive?.id) { mutableStateOf(false) }
    var editing by remember(archive?.id) { mutableStateOf(false) }
    var newName by remember { mutableStateOf("") }
    var instruction by remember(archive?.id) { mutableStateOf(state.preview?.instruction ?: archive?.draft?.instruction.orEmpty()) }
    Surface(shape = RoundedCornerShape(24.dp), tonalElevation = 3.dp) {
        Column(Modifier.fillMaxSize().imePadding().padding(horizontal = if (compact) 14.dp else 20.dp)) {
                Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(top = 8.dp)) {
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
                        state.archives.filter { it.enabled }.forEach { candidate -> DropdownMenuItem(text = { Text("${candidate.name} · ${candidate.platform}") },
                            onClick = { controller.selectArchive(candidate.id); menu = false }) }
                        DropdownMenuItem(text = { Text("新建聊天对象") }, onClick = { menu = false; create = true })
                    }
                }
                if (onCapture != null) Button(onClick = onCapture, enabled = !state.busy) { Text("截屏") }
                if (compact) TextButton(onClick = onClose) { Text("收起") }
                }
                if (archive?.skill?.enabled == true) Text("军师已启用", style = MaterialTheme.typography.labelSmall)
                }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = PaddingValues(top = 8.dp, bottom = 16.dp)) {
            item {
                if (archive != null && more) Row {
                    Text("军师：${if (archive.skill.enabled) "已启用" else "未启用"}", Modifier.weight(1f).padding(top = 12.dp))
                    TextButton(onClick = { safe(controller) { controller.openAdvisor(archive.id) } },enabled = !state.busy) { Text("问军师") }
                }
                if (state.busy) { LinearProgressIndicator(Modifier.fillMaxWidth()); Tip("模型正在看截图并起草回复…") }
                if (state.error.isNotBlank()) Tip(state.error, true)
                if (state.notice.isNotBlank() && !state.busy && (more || state.error.isNotBlank() || !state.notice.contains("已生成"))) Tip(state.notice)
            }
            if (archive == null) item { Block("首次选择聊天对象，以后沿用") {
                state.archives.filter { it.enabled }.forEach { existing -> TextButton(onClick = { controller.selectArchive(existing.id) }) { Text("${existing.name} · ${existing.platform}") } }
                OutlinedTextField(newName, { newName = it }, label = { Text("对方名称") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Button(onClick = { safe(controller) { controller.createArchive(newName, "通用截图") } }, enabled = newName.isNotBlank()) { Text("选定并继续") }
            } }
            if (!state.preview?.pages.isNullOrEmpty() && !state.settings.screenshotUploadAccepted) item { Block("直接看图回复") {
                Text("截图将发送到你配置的多模态模型服务，用于理解对话和生成回复。今后由截图操作直接触发，无需逐条核对。")
                Button(onClick = controller::acceptScreenshotUpload, enabled = !state.busy) { Text("同意并继续") }
            } }
            archive?.draft?.let { draft -> item { Block("回复建议") {
                val locked = draft.state in setOf(DraftState.SUBMITTING, DraftState.SUBMITTED, DraftState.UNKNOWN, DraftState.SENT)
                val stale = draft.contextRevision != archive.revision || !controller.draftIsCurrent()
                if (stale) {
                    Tip("有新内容，原草稿已保留。重新生成或核对后继续使用。", true)
                    if (!locked) TextButton(onClick = { safe(controller) { controller.reviewDraft() } }, enabled = !state.busy) { Text("我已核对，保留此草稿") }
                }
                if (draft.note.isNotBlank() && (draft.uncertain || more)) Tip(draft.note, draft.uncertain)
                draft.alternatives.take(3).forEachIndexed { index, candidate ->
                    val selected = draft.selected == index
                    Surface(onClick = { safe(controller) { controller.chooseAlternative(index) } }, enabled = !state.busy && !locked && !selected,
                        shape = RoundedCornerShape(12.dp), color = if (selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surface,
                        modifier = Modifier.fillMaxWidth().semantics { contentDescription = "回复选项${index + 1}${if (selected) "，已选" else ""}" }) {
                        Row(Modifier.padding(horizontal = 12.dp, vertical = 9.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Text("${index + 1}", style = MaterialTheme.typography.labelLarge)
                            Text(if (selected) draft.text else candidate, maxLines = if (compact) 2 else 4, overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
                if (editing) OutlinedTextField(draft.text, controller::editDraft, label = { Text("回复（可修改）") }, minLines = 1, maxLines = if (compact) 3 else 8,
                    modifier = Modifier.fillMaxWidth(), enabled = !locked)
                val canAct = ContextEngine.canAct(archive) && controller.draftIsCurrent() && !state.busy && !state.settings.paused
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (compact) Button(onClick = { safe(controller) { if (controller.fillDraft()) onClose() } }, enabled = canAct) { Text("填入") }
                    Button(onClick = { safe(controller) { controller.copyDraft() } }, enabled = canAct) { Text("复制") }
                    TextButton(onClick = { editing = !editing }, enabled = !state.busy && !locked) { Text(if (editing) "完成编辑" else "编辑") }
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
                if (more && !compact) Tip("在聊天中长按悬浮按钮可填入这条回复。")
                if (more && archive.notificationScope != null && NotificationReplies.canSend(archive.notificationScope, archive))
                    OutlinedButton(onClick = { safe(controller) { controller.sendNotification() } }, enabled = canAct) { Text("确认通过通知发送") }
                if (draft.state in setOf(DraftState.SUBMITTED, DraftState.UNKNOWN)) Tip("上次发送结果尚未核对，不会自动重试", true)
                if (more || draft.state in setOf(DraftState.SUBMITTED, DraftState.UNKNOWN)) TextButton(onClick = { safe(controller) { controller.acknowledgeSent() } }, enabled = !state.busy && draft.state != DraftState.SENT && (canAct || draft.state in setOf(DraftState.SUBMITTED, DraftState.UNKNOWN))) {
                    Text(if (draft.state == DraftState.SENT) "已记录发送" else "我已发送")
                }
                if (draft.state in setOf(DraftState.SUBMITTED, DraftState.UNKNOWN)) TextButton(onClick = { safe(controller) { controller.acknowledgeNotSent() } }) { Text("已核对，没有发出") }
            } } }
            if (archive != null && (more || archive.draft == null || state.error.isNotBlank())) item {
                OutlinedTextField(instruction, { instruction = it; controller.setInstruction(it) }, label = { Text("想怎么回（可选）") }, placeholder = { Text("简短一点、委婉拒绝…") }, modifier = Modifier.fillMaxWidth(), maxLines = 3)
                Button(onClick = { controller.generate(instruction) }, enabled = !state.busy && !state.settings.paused &&
                    (state.preview?.pages.isNullOrEmpty() || state.settings.screenshotUploadAccepted), modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) {
                    Text(if (archive.draft == null) "重试生成" else "重新生成")
                }
            }
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
                archive?.notificationScope?.let { key -> item {
                    if (NotificationReplies.hasTicket(key)) {
                        var verified by remember(key) { mutableStateOf(NotificationReplies.isVerified(key)) }
                        Row { Checkbox(verified, { verified = it; NotificationReplies.verify(key, it) }); Text("已验证本会话通知快捷回复") }
                    }
                } }
                item { TextButton(onClick = { controller.closePreview(); onClose() }, enabled = !state.busy) { Text("结束本次，清除原始截图") } }
                if (archive?.temporary == true) item {
                    Tip("这是临时聊天，完成时会丢弃；需要留存可先保存。")
                    TextButton(onClick = { controller.saveTemporary(archive.id, archive.name) }) { Text("保存为聊天档案") }
                }
            }
        }
        TextButton(onClick = { more = !more }) { Text(if (more) "收起更多" else "更多") }
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
