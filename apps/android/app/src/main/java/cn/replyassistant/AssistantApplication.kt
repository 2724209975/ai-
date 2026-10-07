package cn.replyassistant

import android.app.Application
import cn.replyassistant.data.AssistantController

class AssistantApplication : Application() {
    lateinit var controller: AssistantController
        private set
    override fun onCreate() { super.onCreate(); controller = AssistantController(this) }
}
