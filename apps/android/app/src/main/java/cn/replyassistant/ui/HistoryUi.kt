package cn.replyassistant.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cn.replyassistant.data.AssistantController
import cn.replyassistant.domain.*
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.launch

@Composable fun HistoryScreen(controller:AssistantController,onReply:()->Unit={controller.closeHistory()}) {
    val state by controller.state.collectAsStateWithLifecycle()
    val archive=state.archives.find {it.id==state.historyArchiveId}
    if(archive==null){LaunchedEffect(Unit){controller.closeHistory()};return}
    var query by remember(archive.id){mutableStateOf("")}
    var searching by remember(archive.id){mutableStateOf(false)}
    var allChannels by remember(archive.id){mutableStateOf(false)}
    var manageChannels by remember(archive.id){mutableStateOf(false)}
    BackHandler {if(searching){searching=false;query=""}else controller.closeHistory()}
    var editing by remember(archive.id){mutableStateOf(false)}
    var adding by remember(archive.id){mutableStateOf(false)}
    var repairPreview by remember(archive.id){mutableStateOf<ChatArchive?>(null)}
    val repaired=remember(repairPreview){repairPreview?.messages?.let(ScreenshotStitcher::repair)}
    val canUndo=remember(archive.messages,archive.historyUndo){archive.historyUndo?.let {ScreenshotStitcher.repair(it)==archive.messages}==true}
    val all=remember(state.archives,archive,allChannels){if(allChannels)archive.personHistory(state.archives) else archive.chatHistory()}
    val rows=remember(all,query){all.filter {query.isBlank()||it.message.text.contains(query,true)}}
    val list=rememberLazyListState();val scope=rememberCoroutineScope()
    LaunchedEffect(archive.id){if(rows.isNotEmpty())list.scrollToItem(rows.size-1)}
    Scaffold(modifier=Modifier.imePadding(),topBar={Column(Modifier.statusBarsPadding().padding(horizontal=16.dp)){
        Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically){
            TextButton(onClick=controller::closeHistory){Text("返回")}
            Column(Modifier.weight(1f)){Text(archive.name,style=MaterialTheme.typography.titleLarge,fontWeight=FontWeight.Bold);Text("${archive.platform} · 聊天记录",style=MaterialTheme.typography.labelMedium)}
            TextButton(onClick={searching=!searching;if(!searching)query=""}){Text(if(searching)"收起搜索" else "搜索")}
        }
        if(searching)OutlinedTextField(query,{query=it},label={Text("搜索聊天内容")},singleLine=true,modifier=Modifier.fillMaxWidth())
        Tip("已保存 ${all.size} 条${if(query.isNotBlank()) " · 找到 ${rows.size} 条" else ""}")
        if(state.error.isNotBlank())Tip(state.error,true)
        Row {
            TextButton(onClick={allChannels=!allChannels}){Text(if(allChannels)"仅当前渠道" else "全部渠道")}
            TextButton(onClick={manageChannels=true}){Text("人物与渠道")}
        }
        Row {
            TextButton(onClick={repairPreview=archive},enabled=!state.busy&&archive.messages.isNotEmpty()){Text("整理重复")}
            if(archive.historyUndo!=null)TextButton(onClick={safe(controller){controller.undoHistoryRepair(archive.id)}},enabled=!state.busy&&canUndo){Text("撤销上次整理")}
        }
    }},bottomBar={Column(Modifier.navigationBarsPadding().padding(horizontal=16.dp,vertical=8.dp)){
        Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){
            TextButton(onClick={adding=true},enabled=!state.busy){Text("补充记录")}
            TextButton(onClick={editing=true},enabled=!state.busy&&archive.messages.isNotEmpty()){Text("纠正手机记录")}
            Button(onClick=onReply,enabled=!state.busy){Text("去回复")}
        }
    }},floatingActionButton={if(rows.isNotEmpty()&&list.canScrollForward)SmallFloatingActionButton(onClick={scope.launch {list.animateScrollToItem(rows.size-1)}}){Text("最新")}}){padding->
        LazyColumn(Modifier.fillMaxSize().padding(padding),state=list,contentPadding=PaddingValues(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
            if(rows.isEmpty())item{Tip(if(query.isNotBlank())"没有找到匹配内容" else "还没有保存聊天记录。截取聊天画面后会保存模型识别的对话，也可以补充文字或关联电脑资料。")}
            items(rows,key={it.key}){row->MessageBubble(row,archive.name)}
        }
    }
    if(editing)HistoryDialog(archive,controller){editing=false}
    if(manageChannels)AlertDialog(onDismissRequest={manageChannels=false},title={Text("人物与聊天渠道")},text={LazyColumn(Modifier.heightIn(max=380.dp)){
        item{Text("当前回复渠道：${archive.name} · ${archive.platform}");Tip("关联只共同参考资料，不搬动原文。当前渠道的新来信单独处理。")}
        val linked=MobilePipelineV2.linkedContext(archive)
        if(archive.desktop?.active==true){item{Tip("已连接电脑：请在工作台「人物与导入」确认关联或解除，然后同步。")};items(linked?.channels.orEmpty(),key={it.contactId}){c->Text("${c.label} · ${c.platform}${if(c.shared)" · 共同参考" else " · 独立使用"}")}}
        else {
            items(state.archives.filter {it.id!=archive.id&&!it.temporary&&!it.desktop.let {d->d?.active==true}},key={it.id}){a->TextButton(onClick={safe(controller){controller.linkPersonChannel(archive.id,a.id);manageChannels=false}},enabled=!state.busy&&!state.linkBusy){Text("确认与 ${a.personName.ifBlank {a.name}} / ${a.platform} 是同一个人")}}
            if(archive.personId!=null)item{TextButton(onClick={safe(controller){controller.linkPersonChannel(archive.id,null);manageChannels=false}},enabled=!state.busy&&!state.linkBusy){Text("解除当前渠道的人物关联")}}
        }
    }},confirmButton={TextButton(onClick={manageChannels=false}){Text("关闭")}})
    repairPreview?.let {preview->
        val before=preview.messages;val after=repaired.orEmpty();val changed=before!=after
        AlertDialog(onDismissRequest={repairPreview=null},title={Text("整理预览 · ${archive.name}")},text={LazyColumn(Modifier.heightIn(max=380.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
            item{Text(if(changed)"${before.size}条 → ${after.size}条，合并${before.size-after.size}条重复。手工草稿保留，可撤销本次整理。" else "没有找到能可靠合并的重复片段，保留当前记录。")}
            item{Tip("只合并能唯一对应的连续对话。无法确定的重复或顺序会保留，请在纠正记录中核对。")}
            if(state.error.isNotBlank())item{Tip(state.error,true)}
            items(after,key={it.id}){Text("${ContextEngine.speakerLabel(it.speaker)}：${it.text}");if(it.orderUncertain)Tip("顺序待确认",true)}
        }},confirmButton={TextButton(onClick={safe(controller){controller.repairHistory(archive.id,preview.revision,after);repairPreview=null}},enabled=changed&&!state.busy){Text("确认整理")}},dismissButton={TextButton(onClick={repairPreview=null}){Text("取消")}})
    }
    if(adding)ManualMessageDialog(onDismiss={adding=false},onAdd={speaker,text->safe(controller){
        val latest=controller.state.value.archives.find {it.id==archive.id} ?: error("档案不存在")
        controller.reviseMessages(archive.id,latest.messages+ChatMessage(speaker=speaker,text=text,timestamp=System.currentTimeMillis()))
        adding=false
    }})
}

@Composable private fun MessageBubble(row:HistoryMessage,name:String){
    val m=row.message;val mine=m.speaker==Speaker.ME
    Row(Modifier.fillMaxWidth(),horizontalArrangement=if(mine)Arrangement.End else Arrangement.Start){
        Column(Modifier.fillMaxWidth(.88f),horizontalAlignment=if(mine)Alignment.End else Alignment.Start){
            val time=m.timestamp?.let {SimpleDateFormat("MM-dd HH:mm",Locale.CHINA).format(Date(it))}.orEmpty()
            Text("${if(mine)"我" else if(m.speaker==Speaker.OTHER)name else "说话人未确定"} · ${row.source}${if(time.isNotBlank())" · $time" else " · 时间未记录"}",style=MaterialTheme.typography.labelSmall)
            Surface(shape=RoundedCornerShape(14.dp),color=if(mine)MaterialTheme.colorScheme.primary.copy(alpha=.12f) else MaterialTheme.colorScheme.surfaceVariant){
                Column(Modifier.padding(12.dp)){
                    SelectionContainer{Text(m.text)}
                    if(m.uncertain)Tip("识别不确定",true)
                    if(m.orderUncertain)Tip("顺序待确认",true)
                    if(m.generated)Tip("AI辅助的已保存发言")
                }
            }
        }
    }
}
