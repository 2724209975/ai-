package cn.replyassistant

import android.os.SystemClock
import androidx.test.platform.app.InstrumentationRegistry
import cn.replyassistant.platform.ChatAccessibilityService
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Opt-in connected-phone check. The host must open the offline fixture first. */
class ConnectedInputDeviceTest {
    @Test fun readsOnlyFixtureWithoutSendingOrReadingUnsentInput() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("fixtureReady")=="true")
        val end=SystemClock.uptimeMillis()+15_000
        while(!ChatAccessibilityService.connected() && SystemClock.uptimeMillis()<end) SystemClock.sleep(100)
        assertTrue("请先启用回复助手无障碍服务",ChatAccessibilityService.connected())
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            // Never read any other app, even if the host did not open the fixture.
            assertEquals("cn.replyassistant.fixture",ChatAccessibilityService.rememberTarget())
            val layout=ChatAccessibilityService.readLayout()!!
            assertTrue(layout.contains("合成聊天"))
            assertTrue(layout.contains("咖啡"))
            assertTrue(layout.contains("发送按钮点击次数：0"))
        }
    }
}
