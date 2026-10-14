package cn.replyassistant.domain

import java.net.URI

object ModelDiagnostics {
 fun endpointError(value:String):String?=runCatching {val u=URI(value);when {u.scheme!="https"||u.host.isNullOrBlank()->"接口需填写完整 HTTPS 地址";u.userInfo!=null||u.query!=null||u.fragment!=null->"接口不能带密钥、查询参数或片段";else->null}}.getOrElse {"接口格式不正确"}
 private fun issue(label:String,endpoint:String,model:String,key:String,optional:Boolean):String? {
  if(key.isBlank()&&optional)return if(endpoint.isNotBlank()&&model.isBlank())"$label：模型名称未填写" else null
  if(key.isBlank())return "$label：密钥未填写"
  if(model.isBlank())return "$label：模型名称未填写"
  if(key.length>8192||key.any {it.code !in 33..126})return "$label：密钥包含空格或换行"
  return endpointError(endpoint)?.let {"$label：$it"}
 }
 fun errors(s:ModelSettings):List<String> = buildList {
  issue("截图识别",s.visionEndpoint,s.visionModel,s.visionKey,true)?.let(::add)
  issue("低成本模型",s.textEndpoint,s.textModel,s.textKey,true)?.let(::add)
  if(listOf(s.qualityEndpoint,s.qualityModel,s.qualityKey).any {it.isNotBlank()})issue("高档模型",s.qualityEndpoint,s.qualityModel,s.qualityKey,false)?.let(::add)
  if(s.visionKey.isNotBlank()&&s.visionEndpoint.isBlank())add("截图识别：接口未填写")
  if(!s.dailyCnyLimit.isFinite()||s.dailyCnyLimit<0||s.dailyCnyLimit>10)add("每日手机费用上限应在0–10元内；0表示不额外设置每日金额限制")
  for(p in listOf(s.visionPrice,s.textPrice,s.qualityPrice))if(listOf(p.inputPerMillion,p.outputPerMillion).any {!it.isFinite()||it<0||it>100000})add("模型价格必须是有效非负数")
 }
 fun summary(s:ModelSettings)=listOf(
  "截图识别："+if(s.visionKey.isBlank())"尚未配置；仍可手动补充文字" else s.visionModel,
  "决策和日常回复："+if(s.textKey.isNotBlank())s.textModel else if(s.visionKey.isNotBlank())"沿用 ${s.visionModel}" else "尚未配置",
  "复杂回复："+if(s.qualityKey.isNotBlank())s.qualityModel else "高档未配置，使用低成本模型并提示核对",
  "以上为本机配置检查，不会发起模型请求；接口可达性和实际效果留待试用。")
}
fun ReplyDraft.explanation():List<String> {
 val c=contextV2?:return listOf("旧版草稿，请根据当前聊天重新核对")
 val d=decisionV2?:return emptyList()
 return buildList {
  add("手机独立生成 · $generationModel")
  add(if(d.risk_level=="high")"本轮涉及复杂或敏感内容，优先选择高档模型；未配置时提示核对" else "本轮为日常对话，使用低成本模型")
  add("参考 ${c.recentMessages.size} 条近期聊天、${c.memories.size} 条有效记忆；${if(c.earlierBackground.isBlank())"没有较早背景" else "包含较早背景"}")
  c.memories.take(8).forEach {add("记忆依据：${it.content.take(180)}")}
  val evidence=c.recentMessages.filter {it.id in d.evidence_message_ids};evidence.take(4).forEach {add("聊天依据：${ContextEngine.speakerLabel(it.speaker)} · ${it.text.take(160)}")}
  add("本轮意图：${d.intent.take(100)}；语气：${d.tone.take(80)}")
 }
}
