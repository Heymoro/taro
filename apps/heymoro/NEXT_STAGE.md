# 归档：Figma v1.26 创作闭环历史实施计划

> **历史归档，不是当前契约或执行入口。** 以下正文、日期、命令与证据原样保留，仅反映当时工程上下文；其中“当前／本轮／下一步”、固定接口及服务／构建操作不作为现行需求、进度或授权。现行工程说明与默认命令见 [README.md](README.md)；正式产品、Figma、技术方案与推进证据统一见私有 [Heymoro Product Lab](https://github.com/Heymoro/product-lab/blob/main/products/heymoro/README.md) 和[实施计划](https://github.com/Heymoro/product-lab/blob/main/products/heymoro/implementation-plan.md)。

> 执行：测试先行；后端与客户端独立边界，分段审查；不修改框架、不进入 starter、不部署生产。

**目标**：微信系统选多图 → 页内输入 → 可恢复生成任务 → 查看成品 → 收藏及再次打开。

**架构**：复用 Payload 登录、私有媒体和 SQLite，新增会话与生成任务，使用原生持久 jobs。Taro 三入口：首页／特效／我的；创作和收纳为二级页。系统提示词仅在服务器；图片入库成功后才算成品，原图／Figma 样片不是生成结果。

**技术**：Taro workspace、React 18、SCSS、Payload collections/jobs、服务端 OpenAI Images API。

## 1. 固定接口（均在 /api/v1 下）

- POST /creation-sessions：{templateId} → 会话；GET /creation-sessions：最近会话列表。
- GET /creation-sessions/:id：{session,generations}；PATCH 同地址：{title}。
- POST /generations：{sessionId,prompt,inputMediaIds,clientRequestId} → 任务；重复键复用任务。
- GET /generations/:id：任务；PATCH 同地址：{saved}，不允许修改状态或媒体。
- GET /artifacts?saved=true&page=1&limit=20：分页成功成品；全部视图不带 saved。
- GET /creation-account：{available,reserved,consumed,configured}，服务端控制2点首次试用，预留防并发超用，失败释放、成功存图后扣除。
- 响应包复用 {data,requestId}；任务字段固定 id,sessionId,status,prompt,inputMediaIds,outputMediaId,saved,errorCode,createdAt。状态 queued/running/succeeded/failed/unknown。
- 会话字段固定 id,templateId,title,createdAt,updatedAt。所有列表 {items,page,totalPages,totalDocs}。
- 参考图仅本人 active JPEG/PNG，最多8张，每张≤10MiB、总≤32MiB；内置玩法需图，自由创作可文字；文字≤2000字。
- 模板ID：retro,portrait,plush,garden,duel,free。系统指令版本化，客户端只传补充描述。
- 媒体删除考虑生成参考和产物引用。队列持久化，不用 fire-and-forget 模拟任务。

## 2. 客户端职责

- 复用 auth/api/media，新增 creation API、模板元数据、可测试流程控制器；草稿按账号/会话存本地。
- pages/index：首页；pages/effects：搜索分类；pages/me：账户/收纳/最近会话。
- pages/create：原生多图、输入、轮次；pages/cabinet：全部/收藏；pages/artifact：完整图/收藏/保存相册。
- 共享 Figma tokens、轻量按钮和照片组件；原生导航/胶囊由微信绘制，不复制状态栏和时间。
- 旧 sub1/sub2 页面保留源码与测试但移出一级导航，不把旧记录混入作品。

## 3. 测试与执行

- [ ] 写并先运行失败测试：选图取消/数量/类型、上传失败保留输入、双击防重、超时同键重试、离页后恢复、失败不丢草稿。
- [ ] 后端先测跨账号、PDF拒绝、幂等、并发额度、失败释放、成功存图、收藏、引用保护。
- [ ] 下载 Figma 素材，实现原生选图和真正 Textarea；固定底栏/独立滚动/键盘/安全区。
- [ ] 隔离数据库与上传目录 HTTP 闭环；测试 provider 明确仅测试并禁止生产，不计作真实AI。
- [ ] 客户端/后端回归、Lint、类型、微信构建、开发工具布局；真机单独列结果。

## 4. 边界

无真实 OpenAI 密钥时返回明确未配置，不假造生成成功。当前 tourist AppID/本地API不等于可真机联网；不关闭域名或TLS校验。正式联调需合法 HTTPS API、实际 AppID 和服务端生图环境。首阶段不接收费/订阅/积分包、跨平台发布或AI配文。

## 审查收口

- owner+clientRequestId 唯一且绑定完整输入快照；同键不同内容409。任务创建与额度预留同事务。无配置先拒绝，不预留。
- unknown 与过期 running 租约保留预留，不自动重复请求上游；仅明确失败释放。媒体保存、成功状态与扣点同事务或可恢复幂等收尾。
