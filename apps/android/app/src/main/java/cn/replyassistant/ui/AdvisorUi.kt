package cn.replyassistant.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.background
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cn.replyassistant.data.AssistantController
import cn.replyassistant.domain.*

@Composable internal fun AnalysisView(analysis: AdvisorAnalysis) {
    Text(analysis.summary)
    listOf("事实" to analysis.facts, "推测（非事实）" to analysis.hypotheses,
        "仍未知" to analysis.unknowns, "下一步" to analysis.actions).forEach { (title, rows) ->
        if (rows.isNotEmpty()) { Text(title, style = MaterialTheme.typography.titleSmall); rows.forEach { Text(it) } }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable internal fun AdvisorScreen(controller: AssistantController, onPick: (() -> Unit)?) {
    val state by controller.state.collectAsStateWithLifecycle()
    val archive = state.archives.find { it.id == state.advisorArchiveId } ?: return
    var memoryOpen by remember(archive.id) { mutableStateOf(false) }
    var deleteMemory by remember { mutableStateOf(false) }
    var deleteConsult by remember { mutableStateOf(false) }
    var profile by remember(archive.id, archive.memory.profile) { mutableStateOf(archive.memory.profile) }
    var backgroundOpen by remember(archive.id) { mutableStateOf(false) }
    val historyState = rememberLazyListState()
    LaunchedEffect(archive.id,archive.consultation.turns.size) {
        if (archive.consultation.turns.isNotEmpty()) historyState.animateScrollToItem(archive.consultation.turns.size + if (memoryOpen) 1 else 0)
    }
    Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).imePadding().padding(horizontal = 16.dp)) {
        Column {
            Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background),horizontalArrangement = Arrangement.SpaceBetween) {
                Text("狗头军师 · ${archive.name}", style = MaterialTheme.typography.titleLarge,modifier = Modifier.weight(1f))
                TextButton(onClick = controller::closeAdvisor, enabled = !state.busy) { Text("返回") }
            }
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(),state = historyState,contentPadding = PaddingValues(vertical = 8.dp),verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Tip("咨询只供你参考，不会发送消息；各对象的咨询与关系记忆分别保存。")
            Row { Switch(archive.skill.enabled, { controller.setSkill(archive.id,it) }, enabled = !state.busy); Text("此对象启用狗头军师", Modifier.padding(top = 12.dp)) }
            if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (state.error.isNotBlank()) Tip(state.error,true)
            if (state.notice.isNotBlank()) Tip(state.notice)
            TextButton(onClick = { deleteConsult = true },enabled = !state.busy) { Text("清除咨询记录") }
            archive.consultation.pages.forEachIndexed { index,page -> Row {
                Text("截图 ${index+1}",Modifier.weight(1f))
                TextButton(onClick = { controller.removeConsultImage(archive.id,page.id) },enabled = !state.busy) { Text("移除") }
            } }
            TextButton(onClick = { memoryOpen = !memoryOpen }) { Text("关系档案与记忆 · ${if (!archive.memory.consent) "未开启" else if (archive.memory.paused) "已暂停更新" else "已开启"}") }
        }
        if (memoryOpen) item { Block("关系记忆") {
            if (!archive.memory.consent) {
                Tip("开启后，军师会在本机整理此对象的精简关系记忆，每次更新会提示。可暂停、撤销或删除，内容会随请求提供给你配置的模型服务。")
                Button(onClick = { controller.changeMemory(archive.id,"enable") }, enabled = !state.busy) { Text("同意并开启关系记忆") }
            } else {
                OutlinedTextField(profile,{ profile = it },label = { Text("关系背景、目标、边界；MBTI与评分可选") },modifier = Modifier.fillMaxWidth(),minLines = 3,enabled = !state.busy)
                Row {
                    TextButton(onClick = { controller.changeMemory(archive.id,"profile",profile) }, enabled = !state.busy) { Text("保存背景") }
                    TextButton(onClick = { controller.changeMemory(archive.id,if (archive.memory.paused) "resume" else "pause") }, enabled = !state.busy) { Text(if (archive.memory.paused) "恢复更新" else "暂停更新") }
                }
                TextButton(onClick = { controller.changeMemory(archive.id,"undo") },enabled = !state.busy && archive.memory.undo.isNotEmpty()) { Text("撤销最近记忆更新") }
                archive.memory.entries.forEach { entry ->
                    Text("${when(entry.kind) { "fact" -> "事实"; "user_report" -> "本人转述"; else -> "推测（非事实）" }}：${entry.text}")
                    Tip("来源：${entry.sourceIds.joinToString("、")}")
                }
                TextButton(onClick = { deleteMemory = true },enabled = !state.busy) { Text("删除关系记忆并关闭") }
            }
        } }
        archive.consultation.turns.forEach { turn -> item(key = turn.id) { Block("你：${turn.question}") {
            if (turn.background.isNotBlank()) Tip("补充：${turn.background}")
            AnalysisView(turn.analysis)
            var images by remember { mutableStateOf(false) }
            if (turn.imageDescriptions.isNotEmpty()) {
                TextButton(onClick = { images = !images }) { Text("截图识别记录") }
                if (images) turn.imageDescriptions.forEach { Tip(it) }
            }
            turn.replies.forEachIndexed { index, reply ->
                Text(reply)
                TextButton(onClick = { safe(controller) { controller.useConsultReply(archive.id,turn.id,index) } },enabled = !state.busy) { Text("用作回复") }
            }
        } } }
        }
        Column(Modifier.fillMaxWidth().padding(vertical = 8.dp),verticalArrangement = Arrangement.spacedBy(6.dp)) {
            OutlinedTextField(archive.consultation.question,{ controller.editConsultation(archive.id,it,archive.consultation.background) },
                label = { Text("你想问什么？") },modifier = Modifier.fillMaxWidth(),minLines = 1,maxLines = 3,enabled = !state.busy)
            if (backgroundOpen) OutlinedTextField(archive.consultation.background,{ controller.editConsultation(archive.id,archive.consultation.question,it) },
                label = { Text("补充背景（可选）") },modifier = Modifier.fillMaxWidth(),maxLines = 3,enabled = !state.busy)
            if (archive.consultation.pages.isNotEmpty() && !state.settings.screenshotUploadAccepted) {
                Tip("截图将上传到你配置的模型服务。")
                Button(onClick = controller::acceptScreenshotUpload,enabled = !state.busy) { Text("同意截图上传") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Button(onClick = { controller.consult(archive.id) },enabled = !state.busy && !state.settings.paused && archive.skill.enabled && archive.consultation.question.isNotBlank() &&
                    (archive.consultation.pages.isEmpty() || state.settings.screenshotUploadAccepted)) { Text("发送问题") }
                TextButton(onClick = { backgroundOpen = !backgroundOpen }) { Text(if (backgroundOpen) "收起背景" else "背景") }
                if (onPick != null) TextButton(onClick = onPick,enabled = !state.busy) { Text("补充截图${if (archive.consultation.pages.isNotEmpty()) "（${archive.consultation.pages.size}）" else ""}") }
            }
        }
    }
    if (deleteMemory) AlertDialog(onDismissRequest = { deleteMemory = false }, title = { Text("删除关系记忆？") },text = { Text("背景、记忆及撤销记录会被删除，并关闭自动更新；聊天和咨询记录保留。") },
        confirmButton = { TextButton(onClick = { controller.changeMemory(archive.id,"delete"); deleteMemory = false }) { Text("删除") } },dismissButton = { TextButton(onClick = { deleteMemory = false }) { Text("取消") } })
    if (deleteConsult) AlertDialog(onDismissRequest = { deleteConsult = false },title = { Text("清除咨询记录？") },text = { Text("同时删除待处理截图及以这些咨询为来源的关系记忆。") },
        confirmButton = { TextButton(onClick = { controller.deleteConsultation(archive.id); deleteConsult = false }) { Text("清除") } },dismissButton = { TextButton(onClick = { deleteConsult = false }) { Text("取消") } })
}

@Composable internal fun PreferenceDialog(controller: AssistantController, onDismiss: () -> Unit) {
    val state by controller.state.collectAsStateWithLifecycle()
    val archive = state.archives.find { it.id == state.selectedArchiveId }
    var text by remember { mutableStateOf(archive?.feedback?.lastOrNull()?.instruction.orEmpty()) }
    var global by remember { mutableStateOf(false) }
    var editingId by remember { mutableStateOf<String?>(null) }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("记住这个偏好") },text = {
        LazyColumn(Modifier.heightIn(max = 450.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                OutlinedTextField(text,{ text = it },label = { Text("长期回复偏好") })
                Row { FilterChip(!global,{ global = false; editingId = null },label = { Text("当前对象") }); FilterChip(global,{ global = true; editingId = null },label = { Text("所有对象") }) }
                Tip("快捷反馈默认只改本次，保存后才用于后续。")
            }
            (if (global) state.settings.preferences else archive?.preferences.orEmpty()).forEach { p -> item(key = p.id) {
                Text(p.text)
                Row { TextButton(onClick = { text = p.text; editingId = p.id }) { Text("编辑") }; TextButton(onClick = { controller.deletePreference(p.id,global); if (editingId == p.id) { editingId = null; text = "" } }) { Text("删除") } }
            } }
        }
    },confirmButton = { TextButton(onClick = { safe(controller) { controller.savePreference(text,global,editingId); onDismiss() } },enabled = text.isNotBlank()) { Text("保存") } },dismissButton = { TextButton(onClick = onDismiss) { Text("关闭") } })
}
