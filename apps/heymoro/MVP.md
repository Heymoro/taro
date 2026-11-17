# 归档：MVP 功能缺口与历史实现

> **历史归档，不是当前契约或执行入口。** 以下正文、日期、命令与证据原样保留，仅反映当时工程上下文；其中“当前／本轮／下一步”、固定接口及服务／构建操作不作为现行需求、进度或授权。现行工程说明与默认命令见 [README.md](README.md)；正式产品、Figma、技术方案与推进证据统一见私有 [Heymoro Product Lab](https://github.com/Heymoro/product-lab/blob/main/products/heymoro/README.md) 和[实施计划](https://github.com/Heymoro/product-lab/blob/main/products/heymoro/implementation-plan.md)。

## 审计与优先级

| 优先级 | 功能 | 原有缺口 | 本轮补齐 |
| --- | --- | --- | --- |
| P0 | 记录编辑 | 仅新增和删除；已有后端 GET/PATCH | 读取最新详情、编辑/取消、PATCH 保存、失败保留输入、防重复提交 |
| P0 | 附件关联 | 后端已有归属及引用规则，页面未接入 | 选择本人已有文件、跨附件页保留选择、移除关联、空数组解除全部关联、附件失效提示 |
| P1 | 分页 | 两列表只取默认第一页 | 记录/文件上一页下一页、加载锁、页码、失败不前进、删除末页空页回退；附件选择器分页 |
| P1 | 个人资料 | 后端有 PATCH /me，页面没有表单 | 昵称/头像 URL 修改、清空头像、取消、长度校验、保存后采用后端响应、失败保留草稿 |

不修改原 API 契约；复用现有请求封装、页面和登录令牌。记录标题<=100、正文<=10000、附件<=20；昵称1–80、头像URL<=2048。头像本轮支持地址修改/清空，不包含新上传头像流程。

## 验证与边界

客户端宿主模拟测试检查实际页面处理函数和实际请求模块，不代替微信工具和真机。后端真实 HTTP 覆盖编辑回读、部分更新、附件添加/替换/解除/越权、中文下载、资料回读、非法字段及多页遍历。

迁移 manifest 的原始哈希保留为历史证据，不随业务修改重算。迁移测试已转为来源清单存在性检查，不再阻止后续开发。

本轮不接生产部署、正式微信身份或公网域名；微信安全校验保持开启。后续待补：真机联网验收、长期并发回归。草稿仅保留在当前应用页面内存中；同一会话切换标签页和文件选择器返回保留，切换账号或重启应用不保留，不做本地持久草稿。

## 本轮实际验收

- 客户端测试23/23；包括编辑回填、保存与失败保留、附件添加/移除、分页失败不前进、资料取消与保存、重复提交及跨账号旧响应回归。
- ESLint通过，微信构建通过。
- Payload测试9/9、严格类型检查通过。真实本地HTTP验证资料回读、记录编辑、附件归属/替换/解除、中文下载及21条记录/3个文件的多页遍历通过。
- 页面验收以宿主模拟及构建为证据；微信工具交互和真机尚未验收。
- 全部源码、测试、说明改动均在两个已批准的 apps/heymoro 内；未修改工作区根配置、示例或测试宿主。

## 编辑页内上传与确认流程增量

- 编辑/新建记录内选择文件并上传，直接复用 uploadMedia；成功后自动添加附件 ID，可移除，保存记录才写入关联。
- 文件选择取消不报错；上传失败保留草稿；最多20个附件、单文件10MB，服务端继续校验格式/归属。
- 记录删除、文件删除均要求确认，取消不发送删除请求。
- 放弃修改及切换到另一条记录时对比已载入基线，有修改才确认；已上传但未关联的文件保留在文件列表，不默默删除。
- 同token会话过期保留草稿，防止后台刷新401绕过确认清空输入；真正账号切换清空旧账号数据。

### 本机完整流程回归

先启动 Payload 应用（本机3001），再在本应用运行：

```sh
pnpm test:flow
pnpm lint
pnpm build
```

`test:flow`执行真实页面处理函数/实际客户端请求模块，宿主 React/微信 API 以测试适配器运行；request/upload 实际连接本地 Payload。模拟登录、资料修改、记录页上传、保存、编辑、附件解除、删除取消/确认、退出均有服务端回读断言。文件选择器使用测试生成PDF，不读取用户私人文件。测试清理新建记录、排队文件删除并撤销会话，审计和测试账号保留。

### 微信开发者工具人工核验

已通过官方CLI导入本应用dist，记录页渲染正常；实际输入草稿并点击取消编辑，原生放弃确认框正常，继续编辑保留内容、放弃修改清空内容均通过。

模拟器登录请求实际触发后，Console显示 `http://localhost:3001 不在以下 request 合法域名列表中`。合法域名、TLS和HTTPS校验仍开启，因此模拟器直接联网全流程尚未通过。未购买域名/服务器、未配置正式账号、未开隧道，也未用接口mock伪装模拟器联网通过。

## 2026-11-02：文件页生命周期与验收入口收口

### 修复

- 文件选择器或删除确认框返回同一会话时，不重置正在执行的操作，上传后能正常刷新列表。
- 选择文件期间切换账号，或令牌已经更换但页面尚未触发 show 时，停止旧操作，避免把旧账号选择的文件发给新账号。
- 引用中的文件删除失败，明确提示先解除记录附件关联，并保留列表。
- 文件页在上传前检查10MB限制；记录附件选择器拒绝第21个文件且保留已有选择。

### 可重复验收

Payload 开发服务已在本机3001启动时，在本客户端目录执行：

```sh
pnpm verify:local
```

串行执行 Payload 单元/边界测试、严格类型检查、既有HTTP冒烟、MVP HTTP回归，以及客户端Lint、真实本地HTTP页面流程和微信构建；任一项失败立即停止。不启动外部服务、不变更域名校验、不读取私人测试文件。

本轮客户端完整流程测试38/38、后端9/9；类型检查、两组HTTP回归、Lint和微信构建通过。微信模拟器直接联网/真机仍为独立未通过项，沿用上一轮的实际校验结论，不因自动化成功而标为完成。

## 当前本地 MVP 口径

当前完成定义、优先级缺口及剩余本地收尾工作统一见 `MVP_STATUS.md`。不再将生产部署、正式账号和域名列为本地功能开发的前置条件。


## 2026-11-02：复用核对与记录附件体验收口

- 先核对现有页面、请求模块、记录 DTO、文件集合访问规则及上传/预览/清理服务，不建设新系统。
- 保留原 `uploadMedia`、`openMedia`、记录 CRUD、附件关系和文件 DTO；新增元信息入口仅弥补普通用户按附件 ID 回读的实际缺口。
- 已保存附件的文件名、现有文件翻页后的名称、编辑页预览及信息失败重试已接入原页面，草稿/附件 ID 保留。
- 元信息与下载共用 `findReadableMedia`，避免本轮复制 owner/lifecycle 判断；删除保留原有不同生命周期语义。
- 新增用例先运行失败再实现；本地回归含后端23项、前端49项（真实 HTTP 开启、无跳过）、类型/Lint/微信构建。最终复核后的输出以 acceptance.log 为准。
- 开发者工具首页及记录页实际渲染截图已检查；原生附件预览与真实微信联网/真机不算本轮已验。
- 当前产品资料已集中到 [Heymoro 资料入口](https://github.com/Heymoro/product-lab/blob/main/products/heymoro/README.md)；本文保留历史工程验收，不作为本轮开发授权。


## 2026-11-02：按审计统一记录约束及客户端最小修正

仅改现有应用文件，不动目录、账号或后端文件存储：

| 文件 | 本轮改动 |
| --- | --- |
| `/Users/nako/Documents/ChatGPT/NexaZ/payload/apps/heymoro/src/collections/Records.ts` | 原生字段约束、title beforeValidate、附件maxRows及超限跳过查询 |
| `/Users/nako/Documents/ChatGPT/NexaZ/payload/apps/heymoro/src/service-records.ts` | RECORD_LIMITS单源；parser仅白名单与结构 |
| `/Users/nako/Documents/ChatGPT/NexaZ/payload/apps/heymoro/src/endpoint-records.ts` | 原生ValidationError映射既有400契约 |
| `/Users/nako/Documents/ChatGPT/NexaZ/taro/apps/heymoro/src/api.js` | 共用鉴权头与字符串/对象响应解析；保留204 |
| `/Users/nako/Documents/ChatGPT/NexaZ/taro/apps/heymoro/src/media.js` | 共用选择/校验/错误提示，上传保留业务code |
| `/Users/nako/Documents/ChatGPT/NexaZ/taro/apps/heymoro/src/records.js` | 使用共用鉴权头，不重建请求层 |
| `/Users/nako/Documents/ChatGPT/NexaZ/taro/apps/heymoro/src/pages/sub1/index.jsx` | 复用选择/错误函数，保留草稿与附件关联 |
| `/Users/nako/Documents/ChatGPT/NexaZ/taro/apps/heymoro/src/pages/sub2/index.jsx` | 复用选择/错误函数，预览锁及旧响应守卫 |
| `/Users/nako/Documents/ChatGPT/NexaZ/payload/apps/heymoro/tests/mvp.test.mjs` | 约束单源、结构白名单、ValidationError、超限零查询回归 |
| `/Users/nako/Documents/ChatGPT/NexaZ/payload/apps/heymoro/tests/admin-http.mjs` | 三真实入口创建/编辑/字段边界、20/21附件及失败修改不落库 |
| `/Users/nako/Documents/ChatGPT/NexaZ/taro/apps/heymoro/client.test.cjs` | 上传解析/业务错误、共用选择/鉴权、预览并发/旧响应、204和页面提示 |

关键用例先复现失败，再最小修正。最终 `pnpm verify:local` 退出0：Payload27项、Taro60项，0失败0跳过；strict类型、真实HTTP、Lint、微信构建通过。账号/后端存储和运行配置10文件哈希不变。日志为本目录 acceptance.log。

开发者工具文件页渲染已截图核对；未登录环境没有执行原生文件预览。键盘/读屏和真机验收仍单列，不把宿主用例或构建当成这些验收通过。


## 2026-11-02：文件读取权限收口

本轮仅两处产品源码：

- `/Users/nako/Documents/ChatGPT/NexaZ/payload/apps/heymoro/src/collections/Media.ts`：集合owner/active规则、owner读取及内部字段访问控制；复用原生上传字段合并保留schema/hooks。
- `/Users/nako/Documents/ChatGPT/NexaZ/payload/apps/heymoro/src/endpoint-media.ts`：列表和单项读取使用Payload ACL，保留v1 active-only、401/404、ownerId及下载头。

测试修改：`/Users/nako/Documents/ChatGPT/NexaZ/payload/apps/heymoro/tests/admin-policy.test.mjs`、`/Users/nako/Documents/ChatGPT/NexaZ/payload/apps/heymoro/tests/mvp.test.mjs`、`/Users/nako/Documents/ChatGPT/NexaZ/payload/apps/heymoro/tests/admin-http.mjs`。关键委托/策略用例先红后绿，真实原生本人读取先403复现再修正；验证角色、状态、元信息/GraphQL脱敏与越权拒绝。

最终verify:local退出0：后端33项、前端60项，0失败/跳过；strict类型、Lint、业务HTTP、微信构建通过。49个其他源码哈希不变，未改Taro、账号、上传/删除/存储代码或目录。

另有明确未通过项：授权后的原生 `/api/media/file/:filename` 返回500，已定位file-type运行时动态导入在Webpack内失败；原生字节返回未计入本轮通过。失败日志及范围见本应用MVP_STATUS.md，验收日志已显式NOTE。现有v1内容下载正常，不以临时改存储掩盖原生路由故障。


## 2026-11-02：原生文件URL file-type/webpack 500闭环

上一轮记录的原生500现已修复，历史失败记录保留，不再作为当前未解决项。

| 实际文件 | 改动 |
| --- | --- |
| `/Users/nako/Documents/ChatGPT/NexaZ/payload/apps/heymoro/next.config.mjs` | 唯一实现改动；从Payload解析file-type入口，仅Node server精确匹配并前置原生ESM external，保留既有配置 |
| `/Users/nako/Documents/ChatGPT/NexaZ/payload/apps/heymoro/tests/boundaries.test.mjs` | 配置先红后绿；验证Node ESM、其他依赖/原规则保留、client/Edge不介入 |
| `/Users/nako/Documents/ChatGPT/NexaZ/payload/apps/heymoro/tests/admin-http.mjs` | 恢复原生URL强制正向；PDF/JPEG/PNG原字节、MIME/cache、PDF206/416、本人/他人/Web角色、pending及清理后404 |

根因：框架已经声明file-type external，但Next要求应用根和导入上下文解析一致；pnpm下应用根不能解析而Payload能解析，因此退回打包并破坏库的非字面量动态import。修复复用框架的external机制，不增加下载实现、不禁用文件校验、不改账号或存储。

验证：新配置及真实原生URL先失败，修复后PDF/JPEG/PNG断言通过；verify:local退出0，后端34/前端60项、0失败0跳过，权限/HTTP/类型/Lint/微信构建通过。Payload build:check退出0，仅compile-only；仍有CLI runtime动态依赖警告，不算完整生产或standalone验收。57个业务源码及依赖声明/锁文件哈希未变。

最终日志：`/Users/nako/Documents/ChatGPT/NexaZ/taro/apps/heymoro/acceptance.log`；编译日志：`/Users/nako/Documents/ChatGPT/NexaZ/payload/apps/heymoro/build-check.log`。配置重载时首次服务就绪检测曾超时，恢复200后完整重跑通过。生成的原生route.js已核对为原生字面量import，不再包含file-type的空动态模块上下文。
