package cn.replyassistant.platform

import android.app.*
import android.content.Context
import android.content.Intent
import cn.replyassistant.MainActivity
import cn.replyassistant.R

object ServiceNotifications {
    fun build(context: Context, text: String, capture: Boolean = false): Notification {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("assistant_services", "回复助手运行", NotificationManager.IMPORTANCE_LOW))
        val intent = PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val builder = Notification.Builder(context, "assistant_services").setSmallIcon(R.drawable.ic_assistant)
            .setContentTitle("回复助手").setContentText(text).setContentIntent(intent).setOngoing(true)
        if (capture) builder.addAction(Notification.Action.Builder(null, "结束连续截图",
            PendingIntent.getService(context, 102, Intent(context, CaptureService::class.java).setAction(CaptureService.STOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)).build())
        return builder.build()
    }
}
