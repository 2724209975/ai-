package cn.replyassistant.data

import android.content.Context
import cn.replyassistant.domain.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.time.LocalDate
import java.time.ZoneId

/** Reserve before every independent-pipeline request. Failures and app restarts retain reservations. */
class MobileUsageStore(context:Context,namespace:String) {
 private val prefs=context.getSharedPreferences("${namespace}_v2_usage",Context.MODE_PRIVATE)
 private val json=Json {ignoreUnknownKeys=true;encodeDefaults=true}
 @Synchronized fun snapshot():UsageLedger {
  prefs.getString("ledger",null)?.let {return json.decodeFromString<UsageLedger>(it)}
  val zone=ZoneId.of("Asia/Shanghai");val day=LocalDate.now(zone);val start=day.atStartOfDay(zone).toInstant().toEpochMilli()
  if(prefs.getString("day",null)!=day.toString())return UsageLedger()
  return UsageLedger(calls=List(prefs.getInt("calls",0).coerceIn(0,1000)){UsageCall(at=start,role="legacy",model="旧版预留",inputCeiling=if(it==0)prefs.getLong("tokens",0).coerceAtMost(Int.MAX_VALUE.toLong()).toInt() else 0,outputCeiling=0,reservedMicroCny=0,priced=false)})
 }
 private fun save(l:UsageLedger){check(prefs.edit().putString("ledger",json.encodeToString(l)).commit()) {"无法保存用量记录，请求未继续"}}
 @Synchronized fun reserve(s:ModelSettings,role:String,model:String,input:Int,output:Int):String {
  val zone=ZoneId.of("Asia/Shanghai");val start=LocalDate.now(zone).atStartOfDay(zone).toInstant().toEpochMilli()
  val ledger=snapshot()
  val next=UsagePolicy.append(ledger,s,role,model,input,output,start,System.currentTimeMillis());save(next);return next.calls.last().id
 }
 @Synchronized fun complete(id:String,input:Long?,output:Long?,status:String){val l=snapshot();val c=l.calls.find {it.id==id}?:return;val overflow=input!=null&&input>c.inputCeiling||output!=null&&output>c.outputCeiling;save(l.copy(unsafe=l.unsafe||overflow,calls=l.calls.map {if(it.id==id)it.copy(status=if(overflow)"usage_overflow" else status,actualInput=input,actualOutput=output)else it}))}
 @Synchronized fun accept(g:LinkedBudget,deviceId:String){val l=snapshot();val p=g.phones.singleOrNull {it.deviceId==deviceId};val same=l.grant?.budgetId==g.budgetId&&l.deviceId==deviceId
  require(g.supported||l.grant?.supported!=true){"当前电脑未接入原费用账本，请连接原工作台；离线额度保留"}
  if(!same&&l.grant?.supported==true){val old=l.grant.phones.singleOrNull {it.deviceId==l.deviceId};require(old==null||l.spentMicroCny>=old.limitMicroCny){"旧电脑仍有离线额度，请保留原连接核对，不可切换预算"}}
  require(!same||p==null||p.limitMicroCny>=l.spentMicroCny){"电脑额度小于手机已预留费用，请核对账本"}
  save(l.copy(grant=g,deviceId=deviceId,spentMicroCny=if(same)maxOf(l.spentMicroCny,p?.spentMicroCny?:0)else p?.spentMicroCny?:0,totalCalls=if(same)maxOf(l.totalCalls,p?.calls?:0)else p?.calls?:0,totalTokens=if(same)maxOf(l.totalTokens,p?.tokens?:0)else p?.tokens?:0))
 }
}
