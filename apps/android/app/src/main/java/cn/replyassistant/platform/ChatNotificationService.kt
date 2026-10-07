package cn.replyassistant.platform

import android.app.Notification
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.Intent
import android.content.Context
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import cn.replyassistant.AssistantApplication
import cn.replyassistant.domain.*
import androidx.core.app.NotificationCompat

data class NotificationTicket(val key: String, val notificationKey: String, val sourceId: String,
    val action: PendingIntent, val inputs: Array<RemoteInput>, val capturedAt: Long)

object NotificationReplies {
    private val tickets = mutableMapOf<String, NotificationTicket>()
    // Capability must be explicitly checked on this handset. No platform is enabled by default.
    private val verified = mutableSetOf<String>()
    private val capturedRows = linkedMapOf<String, List<ChatMessage>>()
    fun rememberRows(key: String, rows: List<ChatMessage>) {
        capturedRows[key] = rows
        while (capturedRows.size > 100) capturedRows.remove(capturedRows.keys.first())
    }
    fun pendingRows(key: String): List<ChatMessage> = capturedRows[key].orEmpty()
    fun verify(key: String, value: Boolean) { if (value) verified += key else verified -= key }
    fun isVerified(key: String): Boolean = key in verified
    fun hasTicket(key: String): Boolean = tickets[key]?.let { System.currentTimeMillis() - it.capturedAt < 600_000 } ?: false
    fun put(ticket: NotificationTicket) { tickets[ticket.key] = ticket }
    fun remove(notificationKey: String) { tickets.entries.removeAll { it.value.notificationKey == notificationKey } }
    fun canSend(key: String, archive: ChatArchive): Boolean = archive.enabled && key == archive.notificationScope && key in verified &&
        tickets[key]?.let { ticket -> System.currentTimeMillis() - ticket.capturedAt < 600_000 && archive.messages.any { it.sourceId == ticket.sourceId } } == true
    fun send(context: Context, key: String, archive: ChatArchive, text: String): Boolean {
        if (!canSend(key, archive)) return false
        // Consume the action before invoking it; it cannot be retried by another button press.
        val ticket = tickets.remove(key) ?: return false
        return runCatching {
            val bundle = Bundle().apply { ticket.inputs.forEach { putCharSequence(it.resultKey, text) } }
            val intent = Intent()
            RemoteInput.addResultsToIntent(ticket.inputs, intent, bundle)
            RemoteInput.setResultsSource(intent, RemoteInput.SOURCE_FREE_FORM_INPUT)
            ticket.action.send(context, 0, intent)
        }.isSuccess
    }
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
        NotificationReplies.remove(sbn.key)
        val action = notification.actions?.firstOrNull { action -> action.remoteInputs?.count { it.allowFreeFormInput } == 1 }
        action?.let { NotificationReplies.put(NotificationTicket(scope, sbn.key, rows.last().sourceId,
            it.actionIntent, it.remoteInputs.filter { input -> input.allowFreeFormInput }.toTypedArray(), System.currentTimeMillis())) }
        (application as AssistantApplication).controller.receiveNotification(scope, title, platform, rows)
    }
    override fun onNotificationRemoved(sbn: StatusBarNotification) { NotificationReplies.remove(sbn.key) }
}
