# QQ 新文字被旧消息误阻塞的修复（2026-10-11）

本人反馈“对方已经发消息过来了，为什么没有生成回答”。实际接收正常、生成任务已落库，但多轮文字任务在规则检查阶段被MEDIA_UNCERTAIN跳过，模型调用为0。来源是旧pendingContactBatch按最近owner/agent向后截取消息：实际QQ本人消息保持unknown身份，长期历史中的较早owner之后的所有unknown被不断计入新轮次。因此前一轮恢复暂停只解决状态，没有解决批次误判。

packages/ai/strategy/fake-decision.mts改为：存在v2 ContextPackage时，待回复范围使用03持久化的triggerMessageIds；旧上下文继续原边界算法。触发引用必须非空、唯一且存在于快照中。旧unknown和未解析媒体仍保留原文、角色和证据；它们在当前触发批次内时仍阻止生成，不篡改为owner、不虚构媒体解释。当前停聊请求仍使决策skip。历史及上下文内容保留。

新增真实故障形态单元回归，以及PostgreSQL集成回归：保留早先unknown本人文字，后来真实contact文字能生成PENDING_APPROVAL；提交次数0。完整门禁936项通过（unit432/app33/tools228/contracts11/integration183/e2e49），0失败、0跳过；web类型检查和构建通过，独立测试数据库已停止。日志output/rewrite/verify-qq-trigger-batch.log。

真实私聊的文字上下文回滚检查保留11条unknown旧消息：旧边界规则返回MEDIA_UNCERTAIN，修正后的规则action=reply。该检查没有创建回复、没有模型调用、事务已回滚，只证明实际来源上的规则阻塞已解除。

试用已重启加载修复，保留schema、历史、联系人、页面端口和累计账本；仍无发送worker/发送接口，真实发送关闭。最近实际新消息是图片，本轮未接真实识图，保持跳过；不因代码修复伪造图片答案。后续新文字使用修正后的批次。

候选页补充消息正在生成/未解析消息已跳过/候选失败的提示，避免统一显示“等待”掩盖处理结果；该小改动在完整门禁之后另通过65文件严格类型检查及真实浏览器核对。截图output/rewrite/qq-batch-status.png。检查时模型费用仍0，余0.5元/40次，前序保守累计1.981516元，不重置原10元总授权。
