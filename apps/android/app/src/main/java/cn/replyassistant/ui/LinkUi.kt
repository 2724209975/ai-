package cn.replyassistant.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cn.replyassistant.data.AssistantController
import cn.replyassistant.domain.*
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable internal fun LinkPanel(controller:AssistantController) {
    Block("电脑资料") {
        Text("连接后只同步你关联的对象；电脑关闭后，手机仍可使用已下载资料。")
        OutlinedButton(onClick={controller.openLink()}) {Text("连接电脑 / 管理资料")}
    }
}

@Composable internal fun LinkScreen(controller:AssistantController,onScan:()->Unit) {
    val state by controller.state.collectAsStateWithLifecycle()
    var pasted by rememberSaveable {mutableStateOf("")}
    var archiveId by rememberSaveable(state.linkArchiveId) {mutableStateOf(state.linkArchiveId)}
    var chooseArchive by remember {mutableStateOf(false)}
    var chooseContact by remember {mutableStateOf(false)}
    var contactId by rememberSaveable(archiveId) {mutableStateOf<String?>(null)}
    val archive=state.archives.find {it.id==archiveId&&it.enabled&&!it.temporary}
    val connection=state.settings.linkConnection
    val linked=archive?.desktop
    val active=linked?.active==true&&connection!=null&&linked.deviceId==connection.deviceId
    BackHandler {controller.closeLink()}
    LaunchedEffect(connection?.deviceId) {if(connection!=null)pasted=""}
    LaunchedEffect(connection?.deviceId,state.linkNeedsPairing) {
        if(connection!=null&&!state.linkNeedsPairing) {
            controller.refreshDesktopContacts()
            controller.desktopForeground()
            while(true){kotlinx.coroutines.delay(30000);controller.desktopForeground()}
        }
    }
    Scaffold {padding->
        LazyColumn(Modifier.fillMaxSize().padding(padding).imePadding().padding(horizontal=20.dp),
            contentPadding=PaddingValues(vertical=16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            item {Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween) {
                Text("电脑联动",style=MaterialTheme.typography.headlineSmall)
                TextButton(onClick={controller.closeLink()}) {Text("返回")}
            }}
            item {Block(if(connection==null) "1. 连接电脑" else "连接状态") {
                Text(state.linkStatus)
                if(connection!=null)Tip("连接异常时先确认电脑服务已启动、两端处于同一 Wi-Fi。地址或证书变化请重新配对；原文、已下载资料和草稿会保留。")
                if(state.linkBusy)LinearProgressIndicator(Modifier.fillMaxWidth())
                if(connection==null) {
                    Text("手机与电脑连接同一 Wi-Fi，在电脑「更多 → 手机联动」生成二维码。扫码后再选择要关联的聊天对象。")
                    Button(onClick=onScan,enabled=!state.linkBusy,modifier=Modifier.fillMaxWidth()) {Text("拍摄配对二维码")}
                    OutlinedTextField(pasted,{pasted=it},label={Text("或粘贴配对内容")},modifier=Modifier.fillMaxWidth(),maxLines=4)
                    OutlinedButton(onClick={controller.pairDesktop(pasted)},enabled=!state.linkBusy&&pasted.isNotBlank()) {Text("连接电脑")}
                } else {
                    Text("电脑地址：${java.net.URI(connection.endpoint).host}",style=MaterialTheme.typography.bodySmall)
                    Row {
                        TextButton(onClick={controller.syncDesktop()},enabled=!state.linkBusy&&!state.linkNeedsPairing) {Text("同步全部关联对象")}
                        TextButton(onClick={controller.disconnectDesktop()},enabled=!state.linkBusy) {Text(if(state.linkNeedsPairing) "重新配对" else "断开电脑")}
                    }
                }
                Tip("只上传已保存的聊天文字和已授权背景；模型密钥、截图图片和未发送草稿不会同步。")
            }}
            item {Block("2. 当前聊天对象") {
                OutlinedButton(onClick={chooseArchive=true},enabled=!state.linkBusy,modifier=Modifier.fillMaxWidth()) {Text(archive?.let {"${it.name} · ${it.platform} ▾"} ?: "选择手机对象 ▾")}
                if(archive==null)Text("先选择手机聊天对象，再关联同一个人的电脑联系人。临时对象不参与联动。")
                else if(connection!=null&&!state.linkNeedsPairing) {
                    if(active) {
                        Text("已关联：${linked!!.contactLabel}")
                        val person=MobilePipelineV2.linkedContext(archive)
                        if(person?.personId!=null){Text("同一人物的渠道：${person.channels.joinToString("、") {it.label}}");Tip("在电脑工作台「人物与导入」管理关联。同步后，手机共同参考相关背景，当前渠道的新消息单独处理。")}
                        Text("${archive.linkOperations(connection.deviceId).size} 项手机修改待同步",style=MaterialTheme.typography.bodySmall)
                        Button(onClick={controller.syncDesktop(archive.id)},enabled=!state.linkBusy,modifier=Modifier.fillMaxWidth()) {Text("同步当前对象")}
                        TextButton(onClick={controller.unlinkDesktop(archive.id)},enabled=!state.linkBusy) {Text("解除当前关联（保留资料）")}
                    } else {
                        OutlinedButton(onClick={chooseContact=true},enabled=!state.linkBusy,modifier=Modifier.fillMaxWidth()) {Text(state.desktopContacts.find {it.id==contactId}?.let {"${it.name} · ${it.platform} ▾"} ?: "仅整理手机资料 ▾")}
                        TextButton(onClick={controller.refreshDesktopContacts()},enabled=!state.linkBusy) {Text("刷新电脑联系人")}
                        Button(onClick={controller.bindDesktop(archive.id,contactId)},enabled=!state.linkBusy,modifier=Modifier.fillMaxWidth()) {Text("关联当前对象")}
                        Tip("不选择电脑联系人也可关联：电脑只整理这个手机对象的资料。")
                    }
                }
            }}
            if(archive!=null&&linked!=null) {
                if(active)items(linked.conflicts,key={"conflict:${it.id}"}) {c->Block("两端修改需要选择") {
                    Text("电脑当前版本",style=MaterialTheme.typography.titleSmall)
                    Text(linkVersionText(c.current.kind,c.current.body,c.current.deleted))
                    HorizontalDivider()
                    Text("待合并版本",style=MaterialTheme.typography.titleSmall)
                    Text(linkVersionText(c.operation.kind,c.operation.body,c.operation.deleted))
                    Button(onClick={controller.resolveDesktop(archive.id,c.id,"current")},enabled=!state.linkBusy&&!state.linkNeedsPairing,modifier=Modifier.fillMaxWidth()) {Text("使用电脑当前版本")}
                    OutlinedButton(onClick={controller.resolveDesktop(archive.id,c.id,"incoming")},enabled=!state.linkBusy&&!state.linkNeedsPairing,modifier=Modifier.fillMaxWidth()) {Text("使用待合并版本")}
                }}
                item {Block("3. 手机已下载资料") {
                    Text(if(linked.lastSyncedAt==0L) "尚未完成首次同步" else "最近成功同步：${SimpleDateFormat("MM-dd HH:mm",Locale.CHINA).format(Date(linked.lastSyncedAt))}")
                    if(linked.lastSyncedAt>0&&System.currentTimeMillis()-linked.lastSyncedAt>86400000)Tip("资料超过一天未更新，电脑上新修改或删除的记忆可能尚未下载，请连接后同步。",true)
                    if(!active)Tip("当前未关联，以下为此前下载的资料。")
                    Text("较早背景 · ${if(linked.packet.method=="model") "模型选取原文" else "按当前话题选取原文"} · ${linked.packet.sourceIds.size} 条来源")
                    Text(linked.packet.summary.ifBlank {"较早记录不足，回复时继续使用近期聊天。"})
                    TextButton(onClick={controller.openHistory(archive.id)}) {Text("查看手机与电脑聊天原文")}
                    HorizontalDivider()
                    Text("电脑长期记忆",style=MaterialTheme.typography.titleSmall)
                    val activeMemories=MobilePipelineV2.effectiveMemories(archive)
                    Text("${activeMemories.size}条有效记忆 · 过期、删除、待确认的记忆不用于回复")
                    activeMemories.take(12).forEach {Text("${it.memoryType}：${it.content}",style=MaterialTheme.typography.bodySmall)}
                    Text("表达习惯",style=MaterialTheme.typography.titleSmall)
                    Text(linked.packet.style.ifBlank {"可靠本人发言不足十条，继续积累真实表达。"})
                    linked.packet.examples.take(4).forEach {Text(it,style=MaterialTheme.typography.bodySmall)}
                    Tip("资料用于当前对象的回复建议；电脑关闭后仍可使用。")
                }}
            }
        }
    }
    if(chooseArchive)LinkChooser("选择手机对象",state.archives.filter {it.enabled&&!it.temporary}.map {Triple(it.id,it.name,it.platform)},onClose={chooseArchive=false}) {archiveId=it;controller.openLink(it);chooseArchive=false}
    if(chooseContact)LinkChooser("选择电脑联系人",state.desktopContacts.map {Triple(it.id,it.name,it.platform)},extra={TextButton(onClick={contactId=null;chooseContact=false}) {Text("仅整理手机资料")}},onClose={chooseContact=false}) {contactId=it;chooseContact=false}
}

@Composable private fun LinkChooser(title:String,rows:List<Triple<String,String,String>>,extra:@Composable ()->Unit={},onClose:()->Unit,onSelect:(String)->Unit) {
    var search by rememberSaveable {mutableStateOf("")}
    AlertDialog(onDismissRequest=onClose,title={Text(title)},text={Column {
        OutlinedTextField(search,{search=it},label={Text("搜索名称 / 平台")},singleLine=true,modifier=Modifier.fillMaxWidth())
        extra()
        val matches=rows.filter {(it.second+" "+it.third).contains(search,true)}
        LazyColumn(Modifier.fillMaxWidth().heightIn(max=340.dp)) {
            if(matches.isEmpty())item {Tip("没有匹配对象，可刷新联系人或更换搜索词。")}
            items(matches,key={it.first}) {row->TextButton(onClick={onSelect(row.first)},modifier=Modifier.fillMaxWidth()) {Text("${row.second} · ${row.third}")}}
        }
    }},confirmButton={TextButton(onClick=onClose) {Text("返回")}})
}
