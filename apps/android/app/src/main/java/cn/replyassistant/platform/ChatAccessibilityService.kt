package cn.replyassistant.platform

import android.accessibilityservice.AccessibilityService
import android.graphics.Rect
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import cn.replyassistant.domain.*
import java.lang.ref.WeakReference

/** No autonomous click or message scraping. Each operation comes from an explicit user action. */
class ChatAccessibilityService : AccessibilityService() {
    companion object {
        private var instance = WeakReference<ChatAccessibilityService>(null)
        var targetPackage: String? = null
            private set
        fun connected(): Boolean = instance.get() != null
        fun rememberTarget(): String? {
            targetPackage = null
            targetPackage = instance.get()?.applicationRoot()?.packageName?.toString()
            return targetPackage
        }
        fun readCurrent(): List<ChatMessage>? = instance.get()?.readVisible()
        fun readLayout(): String? = instance.get()?.visibleLayout()
    }
    override fun onServiceConnected() { instance = WeakReference(this) }
    override fun onDestroy() { if (instance.get() === this) instance.clear(); super.onDestroy() }
    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit
    override fun onInterrupt() = Unit

    private fun applicationRoot(): AccessibilityNodeInfo? {
        val candidates = windows.filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }
            .sortedByDescending { it.isFocused || it.isActive }.mapNotNull { it.root }
            .filter { it.packageName?.toString() != packageName }
        return candidates.firstOrNull { targetPackage == null || it.packageName?.toString() == targetPackage }
    }
    private fun nodes(root: AccessibilityNodeInfo): List<AccessibilityNodeInfo> {
        val result = mutableListOf<AccessibilityNodeInfo>()
        fun visit(node: AccessibilityNodeInfo, depth: Int) {
            if (depth > 35 || result.size >= 1500) return
            result += node
            for (i in 0 until node.childCount) node.getChild(i)?.let { visit(it, depth + 1) }
        }
        visit(root, 0); return result
    }
    private fun readVisible(): List<ChatMessage>? {
        val root = applicationRoot() ?: return null
        if (targetPackage == null || root.packageName?.toString() != targetPackage) return null
        val source = newId()
        return nodes(root).filter { it.isVisibleToUser && !it.isPassword && !it.isEditable && !it.text.isNullOrBlank() }
            .take(100).map { ChatMessage(speaker = Speaker.UNKNOWN, text = it.text.toString(),
                origin = Origin.ACCESSIBILITY, sourceId = source, uncertain = true) }.takeIf { it.isNotEmpty() }
    }
    private fun visibleLayout(): String? {
        val root = applicationRoot() ?: return null
        if (targetPackage == null || root.packageName?.toString() != targetPackage) return null
        val bounds = Rect().also(root::getBoundsInScreen)
        val rows = nodes(root).filter { it.isVisibleToUser && !it.isPassword && !it.isEditable &&
            (!it.text.isNullOrBlank() || !it.contentDescription.isNullOrBlank()) }
            .map { node ->
                val rect = Rect().also(node::getBoundsInScreen)
                Triple(rect, node, node.text?.toString()?.takeIf { it.isNotBlank() } ?: node.contentDescription.toString())
            }.filter { !it.first.isEmpty }.sortedWith(compareBy({it.first.top}, {it.first.left}))
            .take(200)
        if (rows.isEmpty()) return null
        return ("应用=$targetPackage，窗口=$bounds\n" + rows.joinToString("\n") { (rect,node,text) ->
            "位置=$rect；控件=${node.className}；ID=${node.viewIdResourceName.orEmpty()}；内容=${text.take(4000)}"
        }).take(100_000)
    }
}
