package cn.replyassistant.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cn.replyassistant.data.AssistantController
import cn.replyassistant.domain.*
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable internal fun BackupPanel(controller:AssistantController,onAction:(String)->Unit){
 val state by controller.state.collectAsStateWithLifecycle();var password by remember {mutableStateOf("")};var includePreferences by remember {mutableStateOf(false)}
 Block("加密备份与恢复") {
  Text("保存聊天原文、档案、手工草稿和回复偏好。截图原图、模型密钥、连接凭据与费用额度不导出。")
  OutlinedTextField(password,{password=it},label={Text("备份密码（至少8位）")},visualTransformation=PasswordVisualTransformation(),modifier=Modifier.fillMaxWidth())
  Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
   Button(onClick={safe(controller){controller.prepareBackup(password);password="";onAction("backupExport")}},enabled=password.length>=8&&!state.backupBusy){Text("导出备份")}
   OutlinedButton(onClick={safe(controller){controller.prepareBackup(password);password="";onAction("backupImport")}},enabled=password.length>=8&&!state.backupBusy){Text("选择备份预览")}
  }
  if(state.backupBusy)LinearProgressIndicator(Modifier.fillMaxWidth())
  Tip("密码丢失无法恢复。恢复只新增档案，同ID档案保留当前版本；不会覆盖模型密钥或清零费用。")
  state.backupPreview?.let {p->
   Text("备份日期：${SimpleDateFormat("yyyy-MM-dd HH:mm",Locale.CHINA).format(Date(p.createdAt))}")
   Text("${p.names.size}个档案、${p.messages}条手机原文、${p.drafts}份当前草稿；${p.existing}个已有档案将跳过")
   p.names.take(12).forEach {Text(it,style=MaterialTheme.typography.bodySmall)}
   Row {Checkbox(includePreferences,{includePreferences=it});Text("同时合并全局回复偏好",Modifier.padding(top=12.dp))}
   Button(onClick={safe(controller){controller.restoreBackup(includePreferences)}},enabled=!state.busy&&!state.linkBusy){Text("确认恢复新增档案")}
   TextButton(onClick=controller::cancelBackup){Text("取消恢复")}
  }
 }
}
@Composable internal fun ModelPriceFields(title:String,price:ModelPrice,onChange:(ModelPrice)->Unit){
 Text(title,style=MaterialTheme.typography.titleSmall)
 var input by remember(price.inputPerMillion){mutableStateOf(price.inputPerMillion.toString())};var output by remember(price.outputPerMillion){mutableStateOf(price.outputPerMillion.toString())}
 OutlinedTextField(input,{input=it;it.toDoubleOrNull()?.let {v->onChange(price.copy(inputPerMillion=v))}},label={Text("输入价格（元 / 百万 token）")},modifier=Modifier.fillMaxWidth())
 OutlinedTextField(output,{output=it;it.toDoubleOrNull()?.let {v->onChange(price.copy(outputPerMillion=v))}},label={Text("输出价格（元 / 百万 token）")},modifier=Modifier.fillMaxWidth())
}
@Composable internal fun UsagePanel(controller:AssistantController){
 val state by controller.state.collectAsStateWithLifecycle();val l=remember(state){runCatching {controller.usageSnapshot()}.getOrDefault(UsageLedger())}
 val day=java.time.LocalDate.now(java.time.ZoneId.of("Asia/Shanghai")).atStartOfDay(java.time.ZoneId.of("Asia/Shanghai")).toInstant().toEpochMilli();val today=l.calls.filter {it.at>=day}
 var details by remember {mutableStateOf(false)}
 Block("费用概览") {
  Text("今日已用约 ${briefMoney(today.sumOf {it.reservedMicroCny})} 元")
  l.grant?.takeIf {it.supported}?.let {g->val a=g.phones.find {it.deviceId==l.deviceId};Text("手机剩余额度约 ${briefMoney(((a?.limitMicroCny?:0)-l.spentMicroCny).coerceAtLeast(0))} 元")}
  if(l.unsafe)Tip("用量超出预留范围，模型调用已暂停",true)
  Tip("费用为保守估算，实际账单以服务商为准。")
  TextButton(onClick={details=!details}){Text(if(details)"收起调用记录" else "查看调用记录")}
  if(details){
  Text("今日 ${today.size} 次调用 · 预留 ${today.sumOf {it.inputCeiling.toLong()+it.outputCeiling}} token")
  Text("按填写价格预留约 ${"%.4f".format(today.sumOf {it.reservedMicroCny}/1e6)} 元；${today.count {!it.priced}} 次未填写价格")
  l.grant?.takeIf {it.supported}?.let {g->val a=g.phones.find {it.deviceId==l.deviceId};Text("手机累计分配 ${"%.4f".format((a?.limitMicroCny?:0)/1e6)} 元 · 已预留 ${"%.4f".format(l.spentMicroCny/1e6)} 元");Text("电脑已记账 ${"%.4f".format(g.desktopMicroCny/1e6)} 元（最近同步快照）")}
  if(l.unsafe)Tip("用量超出预留范围，模型调用已阻止，请核对服务账单",true)
  today.takeLast(8).reversed().forEach {c->Text("${SimpleDateFormat("HH:mm",Locale.CHINA).format(Date(c.at))} · ${when(c.role){"vision"->"识别 / 咨询";"quality"->"复杂回复";else->"决策 / 日常回复"}} · ${c.model} · ${"%.4f".format(c.reservedMicroCny/1e6)}元 · ${when(c.status){"completed"->"已返回";"failed"->"网络失败，保留预留";"usage_unknown"->"未返回用量";"usage_overflow"->"用量超出范围";else->"已预留"}}",style=MaterialTheme.typography.bodySmall)}
  Tip("费用为保守预留，失败与重启不返还，不是服务商账单。手机离线使用已领取额度；断开和撤销连接不会归还额度。")
  }
 }
}

private fun briefMoney(micro:Long):String=if(micro in 1..9999) "不足 0.01" else String.format(Locale.CHINA,"%.2f",micro/1e6)
