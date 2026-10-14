package cn.replyassistant.maintenance
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import cn.replyassistant.AssistantApplication
/** Debug maintenance bridge, restricted to Android shell/system DUMP permission. */
class ClearLocalDataReceiver:BroadcastReceiver(){
 override fun onReceive(context:Context,intent:Intent){
  if(intent.action!="cn.replyassistant.CLEAR_SYNCED_AND_SYNTHETIC")return
  (context.applicationContext as AssistantApplication).controller.clearSyncedAndSyntheticHistory(intent.getBooleanExtra("all",false))
  resultCode=0;resultData="cleared_synced_and_synthetic"
 }
}
