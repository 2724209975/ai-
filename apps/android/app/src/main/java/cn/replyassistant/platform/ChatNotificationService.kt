package cn.replyassistant.platform

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import cn.replyassistant.AssistantApplication
import cn.replyassistant.domain.*
import androidx.core.app.NotificationCompat

object NotificationReplies {
    private val capturedRows = linkedMapOf<String, List<ChatMessage>>()
    fun rememberRows(key: String, rows: List<ChatMessage>) {
        capturedRows[key] = rows
        while (capturedRows.size > 100) capturedRows.remove(capturedRows.keys.first())
    }
    fun pendingRows(key: String): List<ChatMessage> = capturedRows[key].orEmpty()
}

class ChatNotificationService : NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val platform = when (sbn.packageName) { "com.tencent.mm" -> "微信"; "com.tencent.mobileqq" -> "QQ"; else -> return }
        val notification = sbn.notification
        if (notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
        val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(notification)
        if (style?.isGroupConversation == true) return
        val title = notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim().orEmpty()
        if (title.isBlank()) return
        if (title.contains("群聊") || title.contains("群消息")) return
        // Plain notifications require the user's explicit single-chat binding before any body is stored.
        val plain = notification.extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim().orEmpty()
        val latest = style?.messages?.lastOrNull()
        val identity = NotificationIdentityFactory.create(sbn.packageName, title, notification.shortcutId,
            latest?.person?.key, sbn.key, latest?.timestamp ?: sbn.postTime, latest?.text?.toString() ?: plain)
        val scope = identity.scope
        val rows = style?.messages?.mapNotNull { message ->
            val text = message.text?.toString()?.trim().orEmpty()
            // Incoming text only. Attachments and owner's echoed messages require separate evidence.
            if (text.isBlank() || message.person == null) null else ChatMessage(speaker = Speaker.OTHER,
                text = text.take(4000), timestamp = message.timestamp, origin = Origin.NOTIFICATION,
                sourceId = NotificationIdentityFactory.digest("$scope|${message.timestamp}|${message.person?.key ?: message.person?.name}|$text"))
        } ?: if (plain.isNotBlank()) listOf(ChatMessage(speaker = Speaker.OTHER, text = plain.take(4000),
            timestamp = sbn.postTime, origin = Origin.NOTIFICATION,
            sourceId = NotificationIdentityFactory.digest("$scope|${notification.`when`}|$plain"))) else emptyList()
        if (rows.isEmpty()) return
        NotificationReplies.rememberRows(scope, rows)
        (application as AssistantApplication).controller.receiveNotification(scope, title, platform, rows)
    }
}
