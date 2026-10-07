package cn.replyassistant.fixture

import android.app.Activity
import android.os.Bundle
import android.graphics.Color
import android.view.Gravity
import android.widget.*

/** Separate offline app used only to validate cross-application capture and editable nodes. */
class FixtureActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val density = resources.displayMetrics.density
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 70, 24, 40); setBackgroundColor(Color.rgb(246, 247, 243)) }
        fun text(body: String, right: Boolean = false) = TextView(this).apply {
            text = body; textSize = 20f; setTextColor(Color.rgb(30, 50, 45)); setPadding(18, 24, 18, 24)
            gravity = if (right) Gravity.END else Gravity.START
        }
        root.addView(text("小王 · 合成聊天（不联网）"))
        root.addView(text("对方：周末有空吗"))
        root.addView(text("我：周日下午可以", true))
        root.addView(text("对方：那一起喝咖啡吧"))
        root.addView(TextView(this), LinearLayout.LayoutParams(-1, 0, 1f))
        val input = EditText(this).apply { hint = "输入聊天回复"; textSize = 18f; setSingleLine(false); minLines = 2; setText(intent.getStringExtra("preset").orEmpty()) }
        root.addView(input, LinearLayout.LayoutParams(-1, (100 * density).toInt()))
        if (intent.getBooleanExtra("ambiguous", false)) {
            root.addView(EditText(this).apply { hint = "第二个输入框" })
            root.isFocusableInTouchMode = true; root.requestFocus()
        }
        var sent = 0
        val status = text("发送按钮点击次数：0")
        root.addView(Button(this).apply { text = "发送（仅本地测试）"; setOnClickListener { sent++; status.text = "发送按钮点击次数：$sent" } })
        root.addView(status)
        setContentView(root)
    }
}
