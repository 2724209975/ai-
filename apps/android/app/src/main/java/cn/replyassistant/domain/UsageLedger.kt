package cn.replyassistant.domain

import kotlinx.serialization.Serializable
import kotlin.math.ceil

@Serializable data class UsageCall(val id:String=newId(),val at:Long=System.currentTimeMillis(),val role:String,val model:String,val inputCeiling:Int,val outputCeiling:Int,val reservedMicroCny:Long,val priced:Boolean,val status:String="reserved",val actualInput:Long?=null,val actualOutput:Long?=null)
@Serializable data class UsageLedger(val calls:List<UsageCall> = emptyList(),val grant:LinkedBudget?=null,val deviceId:String="",val spentMicroCny:Long=0,val totalCalls:Long=0,val totalTokens:Long=0,val unsafe:Boolean=false)
object UsagePolicy {
 fun price(s:ModelSettings,role:String)=when(role){"vision"->s.visionPrice;"quality"->s.qualityPrice;else->if(s.textKey.isBlank())s.visionPrice else s.textPrice}
 fun charge(input:Int,output:Int,p:ModelPrice):Long {
  require(input>0&&output>0&&listOf(p.inputPerMillion,p.outputPerMillion).all {it.isFinite()&&it>=0&&it<=100000}) {"模型价格或用量无效"}
  val amount=ceil(input*p.inputPerMillion+output*p.outputPerMillion);require(amount<=Long.MAX_VALUE.toDouble()) {"预估费用过大"};return amount.toLong()
 }
 fun append(l:UsageLedger,s:ModelSettings,role:String,model:String,input:Int,output:Int,dayStart:Long,now:Long):UsageLedger {
  val today=l.calls.filter {it.at>=dayStart};val p=price(s,role);val priced=p.inputPerMillion>0&&p.outputPerMillion>0;val amount=charge(input,output,p)
  require(today.size<s.dailyCallLimit&&today.sumOf {it.inputCeiling.toLong()+it.outputCeiling}+input+output<=s.dailyTokenLimit){"今日调用次数或预估用量已达上限"}
  require(!l.unsafe){"模型返回用量超过预留范围，请核对价格与账单后再使用"}
  if(s.dailyCnyLimit>0||l.grant?.supported==true)require(priced){"启用费用限制前，请填写本轮模型的输入和输出价格"}
  if(s.dailyCnyLimit>0)require(today.sumOf {it.reservedMicroCny}+amount<=s.dailyCnyLimit*1e6){"今日手机费用额度不足，资料和草稿已保留"}
  l.grant?.takeIf {it.supported}?.let {g->val a=g.phones.singleOrNull {it.deviceId==l.deviceId};require(!g.halted&&a!=null&&l.spentMicroCny+amount<=a.limitMicroCny){"手机分配额度不足，请在电脑联动页面分配额度后同步"}}
  return l.copy(calls=l.calls.takeLast(999)+UsageCall(at=now,role=role,model=model,inputCeiling=input,outputCeiling=output,reservedMicroCny=amount,priced=priced),spentMicroCny=l.spentMicroCny+amount,totalCalls=l.totalCalls+1,totalTokens=l.totalTokens+input+output)
 }
}
