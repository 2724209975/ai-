# Android 0.3.4：显式截屏与候选点选

日期：2026-10-07。承接 0.3.3 的上半屏面板，调整悬浮按钮语义与候选交互。安装包 `output/android/reply-assistant-0.3.4-debug.apk`，versionCode 8，可覆盖升级并保留本地配置、档案和草稿。

## 改动

- **悬浮按钮不再截屏**：点击和长按都只打开回复面板，不获取画面、不触发系统截屏授权。截屏改为面板内唯一入口，必须先由本人明确点击。
- **顶部一行三个控件**：聊天对象改为小号下拉按钮（沿用带 `contentDescription` 的无障碍标签，显示当前对象名，超出宽度省略），新增「截屏」，保留「收起」，三者同一行排布，面板高度仍是屏幕 48%、宽度 94%、顶部 8dp。
- **三条候选同时列出**：模型返回的候选一次性展示（最多三条），点击即选中并高亮；原先「换一个」的轮换方式取消。选中项显示草稿正文，未选中项显示候选原文，因此切换候选不会丢失手工修改。
- **编辑按需展开**：「编辑」按钮才展开输入框；收起更多或折叠面板都不清空手工编辑内容。旧数据不足三条时按实际数量显示，不补空。

面板主体、错误与不确定提示、首人选择、上传同意、草稿过期提示的显示条件未变；「填入／复制／编辑」保持直接可见，反馈、偏好、军师分析、重写要求、补充／纠正仍在「更多」内。

## 验证

- 构建**全新重跑**：删除 `app\build` 后 84 个任务全部重新执行（无 UP-TO-DATE），`BUILD SUCCESSFUL`，含 `:app:assembleDebug`、`:app:testDebugUnitTest`、`:app:lintDebug`、`:app:assembleDebugAndroidTest`。
- JVM 单元测试 **47 项通过，0 失败、0 跳过**（4 个测试类）。
- Lint **0 错误、17 警告**（较 0.3.2 的 16 项多 1 项，来自 `OverlayService` 中 `SOFT_INPUT_ADJUST_RESIZE` 的平台弃用提示，非本次新增逻辑缺陷）。
- Android 16 隔离模拟器 `PersonalAdvisorUiTest` 3 项通过（`OK (3 tests)`），含 `compactPanelStartsSimpleAndKeepsEditedDraftWhenMoreIsToggled`：三条候选同时可见、点选第二条后草稿随之切换、手工修改进入历史草稿、切换回来保留编辑、展开再收起「更多」后编辑仍在；另两项覆盖偏好/咨询转草稿不发送、透明度滑块保留未保存的模型配置。连续截图与填写用例仍在 `CrossAppDeviceTest` 中，本轮未重跑。
- APK 16 KB 对齐检查 exit 0；签名 v2 有效，证书 `CN=Android Debug`（`SHA-256 8fc5e8ee…4a1c`）。
- 日志：`output/android/android-0.3.4-clean-verify.log`、`android-three-options-final-build.log`、`android-three-options-ui-final.log`。

## 安装

已覆盖安装到目标红米（REDMI K80 Ultra，设备序列号已核实）并核实 versionCode 8 / versionName 0.3.4，`lastUpdateTime` 更新、`firstInstallTime` 不变；启动后停留在主界面，无崩溃，本地数据库仍在原路径，原有档案和草稿（含未发送的候选）保留。未安装测试夹具到日常手机，未发送真实消息，未读取或输出模型密钥。

面板真机外观见 `output/android/device-0.3.4-home.png`：三条候选同时列出、第一条选中高亮，分析提示直接显示，底部「更多」折叠其余操作。

## 真机范围

微信和 QQ 的实际悬浮截屏、无障碍填写与通知兼容性仍需本人在目标手机上验收；模拟器通过不代表澎湃系统上的悬浮窗、权限和输入框兼容性已通过。截屏仍需本人完成首次系统授权，连续截图会话的复用与五分钟闲置释放沿用 0.3.2 行为。

安装包：`output/android/reply-assistant-0.3.4-debug.apk`（59,744,938 字节）。

SHA256：`02E47E86CA28E83F723D89045985940CD76F30BD286927C86437920DFDE80069`。

该哈希对应本轮 clean 重跑后重新归档的构建产物；19:32 的旧产物（`2F42AB8F…74FC0`）已被替换，两者源码相同，仅打包时间戳不同。
