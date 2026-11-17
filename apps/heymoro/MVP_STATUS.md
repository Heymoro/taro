# 归档：本地开发 MVP 历史状态

> **历史归档，不是当前契约或执行入口。** 以下正文、日期、命令与证据原样保留，仅反映当时工程上下文；其中“当前／本轮／下一步”、固定接口及服务／构建操作不作为现行需求、进度或授权。现行工程说明与默认命令见 [README.md](README.md)；正式产品、Figma、技术方案与推进证据统一见私有 [Heymoro Product Lab](https://github.com/Heymoro/product-lab/blob/main/products/heymoro/README.md) 和[实施计划](https://github.com/Heymoro/product-lab/blob/main/products/heymoro/implementation-plan.md)。

更新：2026-11-02。当前资料见 [产品资料入口](https://github.com/Heymoro/product-lab/blob/main/products/heymoro/README.md)；本文与 `NEXT_STAGE.md`、`MVP.md` 保留历史工程记录，不作为本轮开发授权。

## 产品与开发边界

继续开发小程序 MVP：普通用户资料、私有记录、私有文件及附件，Payload 原生后台承担管理工作。一个人一份产品账号，权限按职责控制；内部账号实现不是独立迁移项目，也不是小程序下一步前置。

当前代码仍有 admins/users 两类主体，这是内部实现现状，文档不声称已成为单主体。普通用户不增加第二套注册，不加账号迁移/凭据绑定页面。仍只改两个 apps/heymoro，不生产部署、不引入 starter、不新仓库。

## 本轮：修复原生文件URL的file-type/webpack 500

- 产品实现只改现有 Payload 应用的 next.config.mjs，没有另写下载或改账号、权限、文件存储。
- 已有 withPayload.serverExternalPackages 包含 file-type；根因是应用根无法解析这个传递依赖，Next解析一致性检查退回打包。仅Node服务端精确匹配file-type，从Payload上下文解析实际入口，以原生ESM import加载；保留原有externals、withPayload、客户端/Edge及其他依赖处理。
- 新配置用例先失败、原生正向HTTP先复现500，再最小修改。生成route.js已核对为字面量Node import，旧file-type空动态上下文不再出现。
- 57个业务源码及依赖声明/锁文件与本轮开始时SHA-256一致：包括全部账号、存储、下载实现和Taro源码；没有安装新依赖、改父锁文件或移动目录。
- 结论仅覆盖当前本地Webpack+Node；未验证Turbopack、Edge执行、standalone迁移或生产发布。入口根据当前安装解析，不硬编码pnpm版本/路径。

## 前轮：文件读取权限收口（仅后端）

- 管理端仍是 Payload Web，小程序仅C端功能；本轮没有管理员小程序、没有修改Taro源码。
- 产品源码仅改 Media.ts / endpoint-media.ts：本人active读取条件统一由 Media.access.read 返回 Where；管理员、运营保留Web管理读取范围。v1列表、元信息和下载使用 overrideAccess:false 及请求用户，不再另写owner过滤；v1保留active-only协议。
- owner只开放读取，不开放更新；清理状态、错误、存储名别名/内部URL等字段对普通用户隐藏，复用Payload原生字段访问控制及上传字段合并，不改文件schema、原生hooks或存储实现。
- 测试覆盖本人/他人/匿名/停用、Web管理员/运营；v1、原生REST和GraphQL读取；伪造where/overrideAccess/showHiddenFields/select；pending/physicalDeleted不可供C端读取；读权限不扩大写权限。
- 上传、删除、清理及内部附件查找保持原样。49个其他源码文件（包含全部Taro源码、账号及存储实现）与本轮开始时SHA-256一致，没有搬目录。

### 原生文件URL 500：本轮已修复，保留历史失败证据

修复前 `/api/media/file/:filename` 授权后因 file-type v22 的 importAtRuntime 被Webpack编译为空动态模块上下文，报 Cannot find module 'node:fs/promises'。历史失败证据：`/Users/nako/Documents/ChatGPT/NexaZ/payload/apps/heymoro/.data/admin-acceptance-1793611957745/server.log`。

现已恢复强制正向断言：PDF/JPEG/PNG 原生及v1 URL均检查200、MIME、私有缓存和原字节；PDF另验206部分读取和416越界Range；本人、Web管理员/运营、他人拒绝、pending管理可读与C端拒绝、清理后404均通过。此前的失败排除注释和NOTE已移除，不以仅权限通过代替内容读取。

## 前轮：记录约束与客户端逻辑

- 记录标题规范化、标题/正文长度和附件20个上限收口到 Payload 集合字段；阈值由现有 service-records 导出的 RECORD_LIMITS 定义。接口 parser 仅保留白名单和结构检查，原生 ValidationError 映射为既有400 VALIDATION_FAILED。
- 实际 v1、普通用户原生 REST、管理 REST 三入口验证：新增/编辑标题 trim，空白/超长标题和正文拒绝，部分更新保留原字段，附件20个成功/21个拒绝，失败修改不改变已保存数据。
- 超限附件跳过逐文件查找，由原生 maxRows 拒绝；200个ID的内存回归确认0次附件查询，防止集中规则后引入无用查询。
- 记录/文件请求共用鉴权头小函数；两页共用选文件、10MB限制、取消识别和上传错误提示，不引入新的请求或状态框架。
- 上传字符串/对象响应统一走原有响应解析，保留后端错误码，异常响应为 INVALID_RESPONSE，204空响应保持兼容。
- 文件页预览复用现有操作锁与版本/token守卫：阻止重复打开，旧错误不更新新账号页面，旧完成不释放新操作锁。
- 未搬目录、未改账号/文件存储逻辑；10个账号、存储及运行配置源码文件与本轮开始时SHA-256一致。隔离HTTP用例使用脚本专属临时库/目录；原有本地业务回归只创建其自身测试数据。

## 已有核心能力

- 开发身份登录、资料查看/修改、会话退出/撤销/到期及账号停用。
- 私有记录新增、读取、编辑、删除、分页与放弃编辑确认。
- 文件上传、鉴权下载、图片/PDF 预览适配、分页、删除确认及引用保护。
- 编辑页选择已有文件、上传新附件、替换/解除关系；失败保留草稿，异步操作隔离账号。
- 原生后台管理员/运营权限及审计，最后管理员与部分并发保护。
- 文件只清理明确标为 pendingDelete 的项，独立 active 文件不会因未关联或放久被清理。

## 上一批次：附件名称与预览

1. 后端 GET `/api/v1/media/:id` 返回可读 active 文件元信息，复用现有权限/查找/DTO；匿名401，他人/不存在/已删除404，不返回存储名。
2. 记录重新进入编辑时回读附件文件名；选择已有文件翻页后仍保留已选名称，上传名称继续复用。
3. 编辑页复用现有鉴权下载和预览模块，不生成公开文件地址。
4. 附件信息失败可重试，正文、附件 ID 与用户草稿不被清空；预览失败可再次尝试。
5. 元信息旧响应按账号/generation 检查；下载结束账号已更换时，不打开旧账号原生预览。

## 本轮验证

配置重载期间首次就绪探针超时，确认本地服务恢复200后重新执行完整回归；下面是最终结果，不把超时那次计为通过。

在本客户端执行 `pnpm verify:local`，退出码0。完整日志：`/Users/nako/Documents/ChatGPT/NexaZ/taro/apps/heymoro/acceptance.log`。

- Payload 34项单元/边界测试，严格类型检查通过。
- 隔离管理 HTTP：文件读取ACL矩阵与字段脱敏、pending/physicalDeleted、三入口记录约束；原有角色/停用/过期/清理/并发保护通过。原生URL的PDF/JPEG/PNG正向读取、PDF Range及生命周期断言已强制执行并通过，不再有排除NOTE。
- 本地业务 HTTP：资料、记录、附件关系、文件及分页；元信息本人/他人/匿名/不存在/删除状态边界通过。
- Taro 60项测试通过、0失败、0跳过，包含实际本地 HTTP 页面完整流程和附件元信息/预览下载。
- ESLint、微信构建通过；Payload `pnpm build:check` 退出0（严格类型及compile-only，不是完整生产构建）。编译仍有CLI runtime动态依赖表达式警告，未扩大为CLI重构。
- 开发者工具：本轮文件页实际渲染并截图检查，保持合法域名校验；当前未登录，无文件项，原生预览操作未在工具中验收。预览并发与跨账号结果由实际页面代码宿主测试覆盖，不冒充原生/真机验收。

此前33/60、27/60、23/49、21/42等基线属于旧轮次，不替代本次结果。Browserslist 数据过期与 Node SQLite 实验性提示为既有警告，本轮未扩大依赖升级。

无障碍证据范围：WCAG 3.3.1（错误识别）/3.3.3（修正建议）有错误码和页面提示自动化断言；2.1.1（键盘）、4.1.3（状态消息）及读屏通知未人工/AT验证，不声明整体符合性。原生后台字段组件未替换。

## 2026-11-03：附件与删除并发

- 保留原记录集合附件校验；文件排队和管理员清理复用 Payload 写事务。关联与删除竞争按提交顺序返回明确的冲突；重复清理重新查询，不重复计数。
- 隔离 HTTP 回归覆盖关联/解除与删除交错、清理期间拒绝关联已待删文件、双批次合计一次、历史待删但仍被引用时保留文件。未变更小程序运行代码、账号、文件目录或存储实现。
- 本地 `pnpm verify:local` 退出 0：Payload 34 项、Taro 60 项均通过且无跳过，类型检查、真实 HTTP、Lint 和微信构建通过。使用独立测试数据库及上传目录，未使用手工开发数据。见[验收日志](../../../payload/apps/heymoro/.data/mixed-acceptance.Mtk9XR/acceptance.log)。

## 2026-11-04：文件页与个人资料状态巡检

- 文件页仅在读取成功且列表为空时提示上传；读取失败和登录失效各有对应入口。翻页失败保留上一页数据，重试失败的页；删除成功后即移除该项，刷新失败时只重读、不重复删除。
- 首页区分资料读取失败与未登录，统计未取得时显示「—」而不是 0。资料保存失败在表单内提示，保留草稿并用原保存按钮重试；取消清除提示，会话切换不提交旧草稿。
- `pnpm verify:local` 退出 0：Payload 34 项、Taro 68 项全部通过、无跳过；类型、真实 HTTP、Lint 和微信构建通过。[本轮验收日志](../../../payload/apps/heymoro/.data/page-state-acceptance.AMtraJ/acceptance.log)。本轮未重做微信原生网络和真机验收。

## 2026-11-04：微信开发者工具实测

- 重新构建当前应用，模拟器实际加载了首页、记录页和文件页；文件页未登录时显示「去首页登录」，未显示虚假的空列表。
- 在最新构建点击「微信登录」后，微信控制台显示 `request 合法域名校验出错`，明确拒绝 `http://127.0.0.1:3001`。本地 Payload 就绪接口同时返回 200。项目合法域名校验保持开启，模拟器请求未到达后端；未登录的页面渲染不计入微信端到端通过。
- 同批 [本地回归日志](../../../payload/apps/heymoro/.data/native-e2e.Y89eVw/acceptance.log)：Payload 34 项、Taro 68 项、无失败或跳过，含实际小程序页面源码与真实 Payload HTTP 的完整业务回归（微信宿主接口由测试驱动，本地使用 mock 身份）。
- 微信端继续验收需使用该小程序已有或后续配置的合法 HTTPS 测试 API；校验登录、资料保存、记录 CRUD、文件上传及预览后，再单独判定模拟器和真机结果。

## 2026-11-04：同 Wi-Fi 真机联调准备

- 本地 `pnpm verify:local` 已重跑：Payload 34 项、Taro 68 项全通过、无跳过；[日志](../../../payload/apps/heymoro/.data/lan-device.B1NcJm/acceptance.log)。
- 仅在本机 Wi-Fi 地址开放临时小程序 API 入口，转发至隔离的本地 Payload 与测试数据；管理后台、管理 API、GraphQL 和清理接口不通过该入口。电脑端经该入口验证了 mock 登录、记录修改/回读、上传和原字节下载。
- 微信开发者工具已生成开发预览码，构建保持 `urlCheck: true`。扫码并核对手机画面与后端日志前，真机联调仍未验收；本轮是局域网测试身份，不是微信真实身份或合法 HTTPS 域名验收。
- 远程开发续验不要求用户扫码。重新运行 `pnpm test:flow`，68 项均通过；同机微信模拟器实际点击登录后报告 `Cannot send network request to localhost`，局域网入口无对应请求，不能把同机模拟器当成第二台设备。真机项暂缓，临时 Wi-Fi 入口已关闭。

## 2026-11-04：第二机型模拟验证（Nexus 5）

- 在微信开发者工具由 iPhone 12/13 (Pro) 切换至 Nexus 5。实际巡检首页、记录、文件，复现记录页未登录时仍显示空列表和可操作编辑器。已补用例并修复：读取成功后才显示空态；未登录引导回首页；会话失效时当前草稿保留，保存/上传不可操作。重新构建后在 Nexus 5 复核了记录页提示和返回首页。
- 实际点击微信登录仍被合法域名校验拦截；同一时段本地 Payload readiness 返回 200，模拟器登录没有打到后端。两种设备配置仍是同一个微信模拟器，不能当成独立真机或将原生网络验收记为通过。
- 修复后 `pnpm verify:local` 通过：Payload 34 项、Taro 70 项，0 失败、0 跳过。[验收日志](../../../payload/apps/heymoro/.data/simulator-two.53p0LE/after-fix.log)

## 本地开发：PDF 与图片完整回归

- 不依赖 Windows。小程序实际页面代码接隔离 Payload HTTP，分别走 PDF 和 PNG 的上传、关联、重开、鉴权下载，断言 MIME 和完整原始字节，并确认调用对应的文档/图片预览接口。预览宿主由测试模拟，不计入微信原生预览验收。
- `pnpm verify:local` 退出 0：Payload 34 项、Taro 71 项，无失败或跳过。[验收日志](../../../payload/apps/heymoro/.data/local-media-acceptance.nZrwCN/acceptance.log)

## 本地开发：重启持久化验收

- 隔离测试实例实际停机再启动（不同进程，同一测试库及上传目录），原会话、记录标题、附件关联、文件名、MIME 和完整图片字节均可回读。匿名下载、引用中删除、待删后的下载及退出后的旧会话按预期拒绝。[重启日志](../../../payload/apps/heymoro/.data/restart-acceptance.31Ssnh/persistence.log)
- 重启后 `pnpm verify:local` 再跑通过：Payload 34 项、Taro 71 项，0 失败、0 跳过。[完整回归日志](../../../payload/apps/heymoro/.data/restart-acceptance.31Ssnh/acceptance.log)

## 仍需完成

1. **P1：后台清理操作体验**——管理员预览、确认、批次结果与失败重试；不放到小程序，不擅自清理手工开发数据。
2. **P2：剩余用户端体验**——实际页面布局、触控及原生交互巡检，有缺口再增量修复。
3. **平台单列**——原生文件选择/预览、微信真实身份/合法 HTTPS 联网、真机兼容独立验收；本地页面宿主不冒充平台验收。

正式微信、域名、服务器和发布不作为当前普通业务开发前置；账号权限测试并入对应功能验收，不另起一个账号工程。
