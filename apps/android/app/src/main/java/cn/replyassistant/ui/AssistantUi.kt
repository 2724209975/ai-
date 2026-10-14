package cn.replyassistant.ui

import android.graphics.BitmapFactory
import android.provider.Settings
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cn.replyassistant.data.AssistantController
import cn.replyassistant.domain.*
import cn.replyassistant.platform.ChatAccessibilityService
import cn.replyassistant.platform.NotificationReplies
import cn.replyassistant.platform.OverlayService
import java.io.File

private val Green = Color(0xFF247A68)
@Composable fun AssistantTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = lightColorScheme(primary = Green, secondary = Color(0xFF527568),
        background = Color(0xFFF6F7F3), surface = Color.White, surfaceVariant = Color(0xFFEDF2EC)), content = content)
}
internal fun safe(controller: AssistantController, block: () -> Unit) {
    runCatching(block).onFailure { controller.reportError(it.message ?: "操作未完成，请保留草稿后重试") }
}
@Composable internal fun Tip(text: String, error: Boolean = false) {
    Text(text, color = if (error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(vertical = 6.dp))
}
@Composable internal fun Block(title: String, compact: Boolean = false, content: @Composable ColumnScope.() -> Unit) {
    Card(shape = RoundedCornerShape(20.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(if(compact)8.dp else 16.dp), verticalArrangement = Arrangement.spacedBy(if(compact)6.dp else 10.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold); content()
        }
    }
}

@Composable fun AssistantApp(controller: AssistantController, onPick: () -> Unit, onPermission: (String) -> Unit) {
    val state by controller.state.collectAsStateWithLifecycle()
    var tab by remember { mutableIntStateOf(0) }
    val pageScroll = remember(tab) { LazyListState() }
    var showReply by remember { mutableStateOf(state.preview != null) }
    var newArchive by remember { mutableStateOf(false) }
    if(state.historyArchiveId!=null){HistoryScreen(controller,onReply={safe(controller){controller.selectArchive(state.historyArchiveId!!);controller.closeHistory();controller.closeLink();showReply=true}});return}
    if(state.linkScreen){LinkScreen(controller){onPermission("pairScan")};return}
    LaunchedEffect(state.preview?.id) { if (state.preview != null) showReply = true }
    if (state.advisorArchiveId != null) { AdvisorScreen(controller,onPick); return }
    LaunchedEffect(state.selectedArchiveId, state.archives.find { it.id == state.selectedArchiveId }?.draft?.id) {
        if (state.archives.find { it.id == state.selectedArchiveId }?.draft?.note == "来自军师咨询，请核对当前聊天再发送") showReply = true
    }
    Scaffold(bottomBar = {
        if (!showReply) NavigationBar {
            listOf("待回复", "聊天档案", "模型配置", "设置").forEachIndexed { index, text ->
                NavigationBarItem(selected = tab == index, onClick = { tab = index }, icon = { Text(listOf("◌", "▤", "◇", "⚙")[index]) }, label = { Text(text) })
            }
        }
    }) { padding ->
        if (showReply) Box(Modifier.padding(padding)) {
            ReplyPanel(controller, onClose = { showReply = false }, onPick = onPick)
        } else LazyColumn(Modifier.fillMaxSize().padding(padding).padding(horizontal = 20.dp), state = pageScroll, verticalArrangement = Arrangement.spacedBy(14.dp), contentPadding = PaddingValues(vertical = 20.dp)) {
            item {
                Text("回复助手", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                Tip(when (tab) { 0 -> "生成三条回复供你选，复制后由你粘贴和发送。"; 1 -> "每段聊天独立保存，截图也能接着聊。"; 2 -> "选择模型、填写接口和密钥，然后保存。"; else -> "手机辅助起草，电脑联动整理聊天资料。" })
            }
            if (state.error.isNotBlank()) item { Tip(state.error, true) }
            item {Text("手机 ${cn.replyassistant.BuildConfig.VERSION_NAME} · 本机独立生成，电脑联动同步资料",style=MaterialTheme.typography.labelSmall)}
            if (state.notice.isNotBlank()) item { Tip(state.notice) }
            when (tab) {
                0 -> {
                    item { Block("通用截图回复") {
                        Text("模型直接看截图，自动给你回复建议。聊天对象首次选定，以后沿用。")
                        Button(onClick = { onPermission("start") }, modifier = Modifier.fillMaxWidth()) { Text("开启悬浮助手") }
                        Button(onClick = onPick, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("选择截图 / 图片") }
                        TextButton(onClick = { safe(controller) { controller.startPreview(); showReply = true } }) { Text("手动补充聊天内容") }
                        Tip("点击悬浮“回复”打开面板，再点面板中的“截屏”。一次授权可连续截图；闲置5分钟或关闭助手后结束，可在通知栏提前停止。")
                    } }
                    item { Text("需要回复", style = MaterialTheme.typography.titleLarge) }
                    val pending = state.archives.filter { it.enabled && it.pending }.sortedByDescending { it.updatedAt }
                    if (pending.isEmpty()) item { Tip("还没有待回复的聊天。截图模式随时可用；微信和 QQ 的通知兼容性需在你的手机上验证。") }
                    pending.forEach { archive -> item(key = archive.id) { ArchiveCard(archive, controller, onOpen = { controller.selectArchive(archive.id); showReply = true }) } }
                    val discovered = state.archives.filter { !it.enabled && it.notificationScope != null }
                    if (discovered.isNotEmpty()) item { Text("发现的聊天", style = MaterialTheme.typography.titleMedium); Tip("只保存会话标识，启用后才保存后续通知内容。") }
                    discovered.forEach { archive -> item(key = archive.id) { Block("${archive.name} · ${archive.platform}") {
                        Tip("请确认这是一个单人聊天，通知标题与聊天对象对应。群聊请勿启用；不能确定时使用截图。")
                        if (archive.notificationScope?.startsWith("event:") == true) Tip("此软件没有提供可靠的会话标识，只处理这次通知。下次通知需重新核对，避免同名联系人混在一起。")
                        Button(onClick = { controller.enableArchive(archive.id, true) }) { Text("确认是此单人聊天，启用辅助") }
                    } } }
                }
                1 -> {
                    item { Button(onClick = { newArchive = true }) { Text("新建聊天档案") } }
                    state.archives.filter { it.enabled }.sortedByDescending { it.updatedAt }.forEach { archive ->
                        item(key = archive.id) { ArchiveCard(archive, controller, onOpen = { controller.selectArchive(archive.id); showReply = true }, editable = true) }
                    }
                    if (state.archives.none { it.enabled }) item { Tip("新建一个档案，例如“小王 · 微信”，以后追加截图时继续使用。") }
                }
                2 -> { item { ModelSettingsPanel(controller) } }
                3 -> { item { LinkPanel(controller) }; item { UsagePanel(controller) }; item { BackupPanel(controller,onPermission) }; item { SettingsPanel(controller, onPermission) } }
            }
        }
    }
    if (newArchive) NewArchiveDialog(onDismiss = { newArchive = false }, onCreate = { name, platform, temp ->
        safe(controller) { controller.createArchive(name, platform, temp); newArchive = false }
    })
}

@Composable internal fun ArchiveCard(archive: ChatArchive, controller: AssistantController, onOpen: () -> Unit, editable: Boolean = false) {
    val state by controller.state.collectAsStateWithLifecycle()
    var edit by remember { mutableStateOf(false) }
    var delete by remember { mutableStateOf(false) }
    Block("${archive.name} · ${archive.platform}") {
        val history=remember(archive.messages,archive.desktop?.records){archive.chatHistory()}
        Text(history.lastOrNull()?.message?.let { "${ContextEngine.speakerLabel(it.speaker)}：${it.text.take(100)}" } ?: "还没有保存聊天内容")
        Tip("已保存 ${history.size} 条聊天记录")
        if (archive.draft != null) Tip(if (archive.draft.contextRevision != archive.revision) "有新内容，旧草稿已保留，请重新检查" else "有回复草稿")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = {safe(controller){controller.openHistory(archive.id)}}) { Text("聊天记录") }
            TextButton(onClick = onOpen) { Text("回复") }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = { safe(controller) { controller.openAdvisor(archive.id) } },enabled = !state.busy) { Text("问军师") }
            if (editable) { TextButton(onClick = { edit = true }) { Text("编辑") }; TextButton(onClick = { delete = true }) { Text("删除") } }
        }
    }
    if (edit) ArchiveEditDialog(archive, controller, onDismiss = { edit = false })
    if (delete) AlertDialog(onDismissRequest = { delete = false }, title = { Text("删除 ${archive.name}？") }, text = { Text("这个档案的聊天记录、摘要和草稿将从手机删除。") },
        confirmButton = { TextButton(onClick = { controller.deleteArchive(archive.id); delete = false }) { Text("删除") } }, dismissButton = { TextButton(onClick = { delete = false }) { Text("取消") } })
}

@Composable internal fun PagePreview(page: ScreenshotPage, index: Int, total: Int, controller: AssistantController, busy: Boolean) {
    Block("第 ${index + 1} ${if(page.accessibleText.isBlank()) "张截图" else "页聊天读取"}") {
        val bitmap = remember(page.path) { BitmapFactory.decodeFile(page.path, BitmapFactory.Options().apply { inSampleSize = 4 }) }
        DisposableEffect(bitmap) { onDispose { bitmap?.recycle() } }
        if (bitmap != null) Image(bitmap.asImageBitmap(), contentDescription = "截图预览", modifier = Modifier.fillMaxWidth().heightIn(max = 220.dp))
        Row {
            TextButton(onClick = { controller.updatePreview { p ->
                val pages = p.pages.toMutableList(); if (index > 0) { pages[index] = pages[index - 1].also { pages[index - 1] = page } }; p.copy(pages = pages, bindingConfirmed = false)
            } }, enabled = index > 0 && !busy) { Text("前移") }
            TextButton(onClick = { controller.updatePreview { p ->
                val pages = p.pages.toMutableList(); if (index + 1 < total) { pages[index] = pages[index + 1].also { pages[index + 1] = page } }; p.copy(pages = pages, bindingConfirmed = false)
            } }, enabled = index + 1 < total && !busy) { Text("后移") }
            TextButton(onClick = { controller.updatePreview { p -> p.copy(pages = p.pages.filterNot { it.id == page.id }, bindingConfirmed = false) }; File(page.path).delete() }, enabled = !busy) { Text("删除截图") }
        }
        if (page.imageDescription.isNotBlank()) Tip("图片内容：${page.imageDescription}")
        if(page.accessibleText.isBlank()) TextButton(onClick = { controller.recognizePage(page.id) }, enabled = !busy) { Text("辅助工具：本地 OCR") }
        TextButton(onClick = { controller.updatePreview { p -> p.copy(pages = p.pages.map { old -> if (old.id == page.id) old.copy(rows = old.rows.map { row ->
            when { row.layoutHint.contains("偏右") -> row.copy(speaker = Speaker.ME); row.layoutHint.contains("偏左") -> row.copy(speaker = Speaker.OTHER); else -> row }
        }) else old }, bindingConfirmed = false) } }, enabled = !busy) { Text("此画面左边是对方、右边是我") }
        if (page.rows.isEmpty()) Tip(if(page.accessibleText.isBlank()) "模型会直接看这张截图，无需先识别文字。" else "模型会整理当前可见界面文字，不确定时可改用截图。")
        page.rows.forEachIndexed { rowIndex, row ->
            MessageEditor(row, busy, onChange = { next -> controller.updatePreview { p -> p.copy(pages = p.pages.map { old ->
                if (old.id == page.id) old.copy(rows = old.rows.map { if (it.id == row.id) next else it }, corrected = true) else old
            }, bindingConfirmed = false) } }, onDelete = { controller.updatePreview { p -> p.copy(pages = p.pages.map { old ->
                if (old.id == page.id) old.copy(rows = old.rows.filterNot { it.id == row.id }, corrected = true) else old
            }, bindingConfirmed = false) } }, onUp = if (rowIndex == 0) null else ({ controller.updatePreview { p -> p.copy(pages = p.pages.map { old ->
                if (old.id != page.id) old else { val rows = old.rows.toMutableList(); rows[rowIndex] = rows[rowIndex - 1].also { rows[rowIndex - 1] = row }; old.copy(rows = rows, corrected = true) }
            }, bindingConfirmed = false) } }))
        }
    }
}

@Composable internal fun MessageEditor(row: ChatMessage, busy: Boolean, onChange: (ChatMessage) -> Unit, onDelete: () -> Unit, onUp: (() -> Unit)? = null) {
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(12.dp)).padding(10.dp)) {
        if (row.layoutHint.isNotBlank()) Tip(row.layoutHint)
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            listOf(Speaker.OTHER, Speaker.ME).forEach { speaker -> FilterChip(selected = row.speaker == speaker,
                onClick = { onChange(row.copy(speaker = speaker)) }, enabled = !busy, label = { Text(ContextEngine.speakerLabel(speaker)) }) }
            TextButton(onClick = onDelete, enabled = !busy) { Text("删除") }
            if (onUp != null) TextButton(onClick = onUp, enabled = !busy) { Text("上移") }
        }
        OutlinedTextField(value = row.text, onValueChange = { onChange(row.copy(text = it)) }, modifier = Modifier.fillMaxWidth(), maxLines = 8, enabled = !busy)
        Row { Checkbox(checked = !row.uncertain, onCheckedChange = { onChange(row.copy(uncertain = !it)) }, enabled = !busy); Text("内容已核对", modifier = Modifier.padding(top = 12.dp), style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable internal fun NewArchiveDialog(onDismiss: () -> Unit, onCreate: (String, String, Boolean) -> Unit) {
    var name by remember { mutableStateOf("") }; var platform by remember { mutableStateOf("通用截图") }; var temporary by remember { mutableStateOf(false) }
    var advanced by remember { mutableStateOf(false) }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("选择这段聊天的归属") }, text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(name, { name = it }, label = { Text("名称，例如小王") }, singleLine = true)
        TextButton(onClick = { advanced = !advanced }) { Text("可选设置") }
        if (advanced) {
            OutlinedTextField(platform, { platform = it }, label = { Text("软件 / 场景") }, singleLine = true)
            Row { Checkbox(temporary, { temporary = it }); Text("临时聊天，退出前可转存", Modifier.padding(top = 12.dp)) }
        }
    } }, confirmButton = { TextButton(onClick = { onCreate(name.ifBlank { if (temporary) "临时聊天" else "" }, platform, temporary) }, enabled = name.isNotBlank() || temporary) { Text("创建") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } })
}

@Composable internal fun ManualMessageDialog(onDismiss: () -> Unit, onAdd: (Speaker, String) -> Unit) {
    var text by remember { mutableStateOf("") }; var speaker by remember { mutableStateOf(Speaker.OTHER) }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("补充一条聊天内容") }, text = { Column {
        Row { listOf(Speaker.OTHER, Speaker.ME).forEach { value -> FilterChip(selected = speaker == value, onClick = { speaker = value }, label = { Text(ContextEngine.speakerLabel(value)) }) } }
        OutlinedTextField(text, { text = it }, label = { Text("原文或已确认的图片说明") }, minLines = 3)
    } }, confirmButton = { TextButton(onClick = { onAdd(speaker, text.trim()) }, enabled = text.isNotBlank()) { Text("添加") } }, dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } })
}

@Composable internal fun ArchiveEditDialog(archive: ChatArchive, controller: AssistantController, onDismiss: () -> Unit) {
    var name by remember { mutableStateOf(archive.name) }; var relation by remember { mutableStateOf(archive.relationship) }; var style by remember { mutableStateOf(archive.style) }; var skill by remember { mutableStateOf(archive.skill.enabled) }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("编辑档案") }, text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row { Switch(skill,{ skill = it }); Text("此对象启用狗头军师",Modifier.padding(top = 12.dp)) }
        OutlinedTextField(name, { name = it }, label = { Text("名称") }); OutlinedTextField(relation, { relation = it }, label = { Text("关系说明") }); OutlinedTextField(style, { style = it }, label = { Text("回复偏好") })
    } }, confirmButton = { TextButton(onClick = { controller.mutateArchive(archive.id) { it.copy(name = name.trim(), relationship = relation, style = style, skill = it.skill.copy(enabled = skill), revision = it.revision + 1) }; onDismiss() }, enabled = name.isNotBlank()) { Text("保存") } }, dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } })
}

@Composable internal fun HistoryDialog(archive: ChatArchive, controller: AssistantController, onDismiss: () -> Unit) {
    var rows by remember(archive.id) { mutableStateOf(archive.messages) }
    val openedRevision = remember(archive.id) { archive.revision }
    var orderConfirmed by remember(archive.id){mutableStateOf(false)}
    AlertDialog(onDismissRequest = onDismiss, title = { Text("聊天原文 · ${archive.name}") }, text = {
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.heightIn(max = 480.dp)) {
            item { Tip("修改会使旧回复失效，并根据原文重新整理摘要。") }
            if(rows.any {it.orderUncertain})item{Row{Checkbox(orderConfirmed,{orderConfirmed=it});Text("已确认所显示记录顺序",Modifier.padding(top=12.dp))}}
            rows.forEachIndexed { index,row -> item(key = row.id) { MessageEditor(row, false,
                onChange = { next -> rows = rows.map { if (it.id == row.id) next else it } }, onDelete = { rows = rows.filterNot { it.id == row.id } },
                onUp=if(index==0)null else ({val moved=rows.toMutableList();val previous=moved[index-1];moved[index-1]=moved[index];moved[index]=previous;rows=moved})) } }
        }
    }, confirmButton = { TextButton(onClick = { safe(controller) {
        val latest = controller.state.value.archives.find { it.id == archive.id }
        require(latest?.revision == openedRevision) { "聊天已更新，请重新打开原文，避免覆盖新消息" }
        controller.reviseMessages(archive.id, if(orderConfirmed)rows.map {it.copy(orderUncertain=false)} else rows); onDismiss()
    } }) { Text("保存修改") } }, dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } })
}

@Composable internal fun ModelSettingsPanel(controller: AssistantController) {
    val state by controller.state.collectAsStateWithLifecycle()
    var settings by remember(state.settings) { mutableStateOf(state.settings) }
    var advanced by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Block("千问省钱配置") {
            Tip("低成本决策、日常回复和识图使用 qwen3.7-flash；复杂回复使用 qwen3.5-plus。先填低成本密钥，再复用到另外两档，最后保存模型配置。")
            OutlinedButton(onClick = { settings=QwenPreset.apply(settings) },modifier=Modifier.fillMaxWidth()) { Text("填入千问省钱配置") }
            OutlinedButton(onClick = { settings=QwenPreset.reuseTextKey(settings) },enabled=settings.textKey.isNotBlank() && QwenPreset.isOfficialHost(android.net.Uri.parse(settings.textEndpoint).host) && settings.textEndpoint==settings.visionEndpoint && settings.textEndpoint==settings.qualityEndpoint,modifier=Modifier.fillMaxWidth()) { Text("复用低成本密钥到识图与高档") }
        }
        Block("低成本模型") {
            OutlinedTextField(settings.textEndpoint, { settings = settings.copy(textEndpoint = it) }, label = { Text("完整 HTTPS 接口地址") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(settings.textModel, { settings = settings.copy(textModel = it) }, label = { Text("模型名称") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(settings.textKey, { settings = settings.copy(textKey = it) }, label = { Text("API Key") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
        }
        Block("高档回复模型（可选）") {
            Tip("决策始终使用低成本模型；冲突、敏感或复杂对话使用这里的高档模型。未配置时使用低成本模型并提示核对。两端分别保存模型密钥，电脑关机后手机仍可调用自己的模型。")
            OutlinedTextField(settings.qualityEndpoint,{settings=settings.copy(qualityEndpoint=it)},label={Text("高档 HTTPS 接口")},modifier=Modifier.fillMaxWidth())
            OutlinedTextField(settings.qualityModel,{settings=settings.copy(qualityModel=it)},label={Text("高档模型名称")},modifier=Modifier.fillMaxWidth())
            OutlinedTextField(settings.qualityKey,{settings=settings.copy(qualityKey=it)},label={Text("高档 API Key")},visualTransformation=PasswordVisualTransformation(),modifier=Modifier.fillMaxWidth())
        }
        Block("截图识别模型") {
            Tip("截图先识别成聊天文字，再由手机独立决策和生成三条候选。支持兼容 API 的基础地址（如 https://api.deepseek.com）或完整 Chat Completions 接口；旧版图片配置已保留。")
            OutlinedButton(onClick = {
                val visionIsDeepSeek = android.net.Uri.parse(settings.visionEndpoint).host == "api.deepseek.com"
                val textIsDeepSeek = android.net.Uri.parse(settings.textEndpoint).host == "api.deepseek.com"
                settings = settings.copy(visionEndpoint = "https://api.deepseek.com/chat/completions", visionModel = "deepseek-flash",
                    visionKey = if (visionIsDeepSeek && settings.visionKey.isNotBlank()) settings.visionKey else if (textIsDeepSeek) settings.textKey else "")
            }, modifier = Modifier.fillMaxWidth()) { Text("填入 DeepSeek Flash") }
            OutlinedTextField(settings.visionEndpoint, { settings = settings.copy(visionEndpoint = it) }, label = { Text("模型 HTTPS 接口") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(settings.visionModel, { settings = settings.copy(visionModel = it) }, label = { Text("多模态模型名称") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(settings.visionKey, { settings = settings.copy(visionKey = it) }, label = { Text("多模态 API Key") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
        }
        ModelDiagnostics.errors(settings).distinct().forEach { Tip(it,true) }
        TextButton(onClick = { advanced = !advanced }) { Text(if(advanced) "收起计费参数" else "计费参数") }
        if(advanced) Block("模型价格") {
            Tip("用于保守估算额度，通常保留预设即可。")
            ModelPriceFields("截图识别与军师价格",settings.visionPrice){settings=settings.copy(visionPrice=it)}
            ModelPriceFields("低成本决策与日常回复价格",settings.textPrice){settings=settings.copy(textPrice=it)}
            ModelPriceFields("高档回复价格",settings.qualityPrice){settings=settings.copy(qualityPrice=it)}
        }
        Button(onClick = { controller.saveSettings(settings) },modifier=Modifier.fillMaxWidth()) { Text("保存模型配置") }
    }
}

@Composable internal fun SettingsPanel(controller: AssistantController, onPermission: (String) -> Unit) {
    val state by controller.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var settings by remember(state.settings.copy(bubbleOpacity=1f,panelOpacity=1f)) { mutableStateOf(state.settings) }
    var limits by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Block("悬浮透明度") {
            Text("悬浮按钮透明度：${((1f-state.settings.bubbleOpacity)*100).toInt()}%")
            Slider(value = (1f-state.settings.bubbleOpacity)*100,onValueChange = { controller.previewOverlayOpacity(1f-it/100,state.settings.panelOpacity) },
                onValueChangeFinished = controller::saveOverlayOpacity,valueRange = 0f..80f,modifier = Modifier.semantics { contentDescription = "悬浮按钮透明度" })
            Text("回复面板透明度：${((1f-state.settings.panelOpacity)*100).toInt()}%")
            Slider(value = (1f-state.settings.panelOpacity)*100,onValueChange = { controller.previewOverlayOpacity(state.settings.bubbleOpacity,1f-it/100) },
                onValueChangeFinished = controller::saveOverlayOpacity,valueRange = 0f..80f,modifier = Modifier.semantics { contentDescription = "回复面板透明度" })
            Tip("越大越透明。拖动立即预览，松手保存；只影响悬浮窗，App内保持清晰。")
        }
        Block("手机接入") {
            Text("悬浮窗：${if (Settings.canDrawOverlays(context)) "已允许" else "未允许"}；无障碍：${if (ChatAccessibilityService.connected()) "已连接" else "未连接"}")
            Tip("点击悬浮按钮打开面板，点“截屏”或“读取聊天”生成三条候选。选择并复制后，由你到原聊天粘贴和发送。无障碍仅用于主动读取可见聊天。")
            Row { TextButton(onClick = { onPermission("overlay") }) { Text("悬浮窗权限") }; TextButton(onClick = { onPermission("accessibility") }) { Text("无障碍权限") } }
            Row { TextButton(onClick = { onPermission("notification") }) { Text("读取聊天通知") }; TextButton(onClick = { onPermission("post") }) { Text("运行通知权限") } }
            Row { Button(onClick = { onPermission("start") }) { Text("开启悬浮助手") }; TextButton(onClick = { onPermission("stop") }) { Text("关闭") } }
            Tip("微信／QQ 有些通知不提供可靠的单聊信息，此时使用截图回复。锁屏、静音和后台限制需在你的手机上验证。")
            Tip("澎湃系统若限制后台，请在应用设置中允许自启动及后台运行。撤销权限后可继续手动分享截图。")
        }
        TextButton(onClick = { limits = !limits }) { Text(if(limits) "收起用量限制" else "用量限制") }
        if(limits) Block("用量限制") {
            OutlinedTextField(settings.dailyCnyLimit.toString(),{it.toDoubleOrNull()?.let {v->settings=settings.copy(dailyCnyLimit=v)}},label={Text("每日手机费用上限（元，0为不额外限制）")},modifier=Modifier.fillMaxWidth())
            OutlinedTextField(settings.dailyCallLimit.toString(),{it.toIntOrNull()?.let {v->settings=settings.copy(dailyCallLimit=v)}},label={Text("每日最多调用次数")},modifier=Modifier.fillMaxWidth())
            OutlinedTextField(settings.dailyTokenLimit.toString(),{it.toIntOrNull()?.let {v->settings=settings.copy(dailyTokenLimit=v)}},label={Text("每日预估 token 上限")},modifier=Modifier.fillMaxWidth())
            Tip("文字通常调用两次，截图首次多一次识别。填写服务商价格后估算费用；领取电脑分配额度后，手机每次调用同时受分配额度限制。0不解除电脑额度限制。")
        }
        Block("回复与保存") {
            Row { Switch(settings.collapseAfterAction,{settings=settings.copy(collapseAfterAction=it)}); Text("复制后收起面板",Modifier.padding(start=8.dp,top=12.dp)) }
            Row { Switch(settings.fastReplies,{ settings = settings.copy(fastReplies = it) }); Text("优先快速回复",Modifier.padding(start = 8.dp,top = 12.dp)) }
            Tip("减少重复上下文和日常分析篇幅；官方 DeepSeek 与千问支持型号在快速回复时关闭深度思考，独立军师咨询保留模型默认思考。")
            OutlinedTextField(settings.globalStyle, { settings = settings.copy(globalStyle = it) }, label = { Text("我的回复风格") }, modifier = Modifier.fillMaxWidth(), minLines = 3)
            Row { Switch(settings.paused, { settings = settings.copy(paused = it) }); Text("暂停通知处理与回复生成", Modifier.padding(start = 8.dp, top = 12.dp)) }
            Tip("档案和草稿保存在本机，模型密钥加密保存，不同步到电脑。截图在当前预览期间保留，清除预览后删除；长期保存识别文字及必要图片说明。")
            Button(onClick = { controller.saveSettings(settings); if (settings.paused) onPermission("stop") }, modifier = Modifier.fillMaxWidth()) { Text("保存设置") }
        }
    }
}
