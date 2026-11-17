# Heymoro 微信客户端工程

本应用位于 Taro workspace 的 `apps/heymoro`，直接使用现有 workspace 框架包；这里维护工程导航和命令影响，不维护另一份产品方案或进度表。

## 正式产品资料

以下入口位于私有 [Heymoro Product Lab](https://github.com/Heymoro/product-lab/blob/main/products/heymoro/README.md)，访问需要相应仓库权限：

- [PRD 与原型需求对照](https://github.com/Heymoro/product-lab/blob/main/products/heymoro/prd.md)
- [正式 Figma 源稿与交互原型入口](https://github.com/Heymoro/product-lab/blob/main/products/heymoro/README.md#figma唯一正式原型源)
- [架构与时序](https://github.com/Heymoro/product-lab/blob/main/products/heymoro/architecture.md)、[技术方案](https://github.com/Heymoro/product-lab/blob/main/products/heymoro/technical-design.md)、[接口草案](https://github.com/Heymoro/product-lab/blob/main/products/heymoro/api-reference.md)
- [实施计划、实际证据与待验事项](https://github.com/Heymoro/product-lab/blob/main/products/heymoro/implementation-plan.md)

`MVP.md`、`MVP_STATUS.md`、`NEXT_STAGE.md` 是归档工程记录。其旧接口、旧命令、历史测试数字及“当前／下一步”等用语只属于当时的上下文，不是现行需求、执行授权或默认操作指南。

## 当前本地闭环复验（2026-11-17）

- 最新源码 2330 项记录：2328 passed、0 failed、2 项既有 HTTP skipped；src lint 和固定 Node 24.22.1 的微信编译通过。
- 修复首页／特效共用的自由创作入口：空模板身份不再拼出 `?template=`，避免严格路由校验隐藏描述输入框；合法 ID 不变，无效 `0` 不自动变自由创作。先 RED 后 GREEN，并移除“换一张”残留的业务版本文案。
- 在获准的 R19 临时包实际操作：特效双图＋补充、生成、收藏、按原输入换一张；自由创作双图＋三行描述、生成、收藏、作品查看和收纳切换通过。完整刷新后，照片、文字、成品与收藏保持；后端逐项确认原输入快照、成品、扣点与占用归零。
- 测试连真实 SQLite／Redis／MinIO，身份／图片模型端口及系统选图返回使用明确 fixture，零付费调用；不是手机相册或真实 OpenAI 验收。注入键盘高度 300px 时，特效补充与自由创作输入／生成按钮都位于可视区，不代表物理手机键盘。
- 验证后恢复 R19 原 51 份编译／配置文件及原 40 项本机存储，网络校验恢复；日常项目继续使用原后端及用户数据。私有配置、截图和测试产物未提交。

## 工程地图

| 位置 | 职责与阅读边界 |
| --- | --- |
| `src/app.js`、`src/app.config.js`、`src/app.scss` | 应用入口、实际页面注册与全局样式；页面是否启用以注册表为准 |
| `src/pages/{index,effects,me,create,cabinet,artifact,sessions,example,credits,credit-reservations}/` | 已注册页面，负责页面组装与交互接线；目录存在不代表对应体验已验收 |
| `src/features/creation/` | 创作功能的 workflow hook、时间线／返回／历史协调及 `CreationComposer`、`PhotoInput`、`RoundCard` 等局部组件；组件独有 hook 随组件放置 |
| `src/features/artifact/` | 作品详情 hook、返回接线及收藏写结算协调；不另存一套作品业务事实 |
| `src/features/cabinet/` | 全部／已收藏的独立只读投影、返回前缀重验与原生滚动保位；固定视图协调与几何 hook 分开，不本地增删收藏事实 |
| `src/features/credits/` | 积分 DTO／纯展示、账户与流水／占用读状态、任务绑定导航及页面／滚动宿主桥；只读三种 GET，不含付费或用户释放占用操作 |
| `src/components/primitives.jsx` | 跨页面基础展示组件；目前仍包含官方图 `OfficialImage` 与模板导航 `openTemplate`，二者待独立切片归位，尚未完全纯化 |
| `src/components/PrivateImage/` | 跨页面私图加载、失败占位／点击重试及预览；按 token／accountKey／mediaId 隔离视图。下载与鉴权委托 `creation-api.js`，访问权限由服务端判定；复用其 token＋mediaId 的 Promise 缓存，图片加载错误时使对应项失效，不另建缓存 |
| `src/creation-workflow.js`、`src/creation-input.js`、`src/creation-contract.js`、`src/features/creation/recovery-contract.js` | 分别负责创作业务状态、纯输入构造／结构投影与当前配置校验、远端响应 DTO／decode、本地 pending／恢复契约；两个合同共用纯输入投影，恢复合同不依赖远端 API |
| `src/creation-api.js`、`src/api.js`、`src/auth.js`、`src/media.js`、`src/creation-platform.js` | 客户端 API、鉴权、上传及 Taro／微信宿主边界；服务端实现不在本应用中 |
| `src/cursor-list.js`、`src/retained-cursor-list.js`、`src/use-cursor-list.js`、`src/use-account.js`、`src/use-viewport.js`、`src/templates.js` | 共享分页／前缀重验、生命周期工具与模板访问；retained 只管已提交与候选读取，位置由业务 factory 持有，原 useCursorList 行为不扩大 |
| `src/pages/sub1/`、`src/pages/sub2/`、`src/records.js` | 历史记录／文件模块，不在当前页面注册表中；不将其当成当前产品入口 |
| `src/assets/` | 应用静态资源，不替代正式 Figma 设计源 |
| `client.test.cjs`、`creation.test.cjs`、`pending-submission.test.cjs`、`migration.test.cjs` | 既有客户端、创作、提交门控及迁移来源检查 |
| `tests/unit/`、`tests/fixtures/`、`tests/source.cjs` | 聚焦单元／内存边界回归、复用 fixture 与源码加载支持；不等同于真实 HTTP 或完整微信 Runtime |
| `config/`、`babel.config.js`、`project.config.json` | 应用构建与微信工程配置；不是 Taro 框架全局配置 |
| `scripts/verify-local.mjs` | 默认本地检查编排，只串行运行本应用 test 和 lint |
| `migration-manifest.json` | 历史迁移来源快照，不随业务迭代改写成当前源码哈希 |

## 已安装依赖时的默认检查

前提：现有 workspace 依赖与兼容的 Node／pnpm 已就绪。在本应用目录执行：

```sh
pnpm run verify:local
```

该入口固定以脚本所在应用为 cwd，按序执行 `pnpm run test`、`pnpm run lint`。它不探测端口、不跨仓执行、不启动服务、不安装、不构建、不读取 env 文件；对子命令强制 `LOCAL_MVP_HTTP=false` 和 `COREPACK_ENABLE_NETWORK=0`，不因继承的 HTTP 开关而进入旧真实 HTTP 流程。任一命令失败即停止，非零退出；成功只表示客户端 unit＋src lint 通过。

也可分别运行：

```sh
pnpm run test
pnpm run lint
```

`test` 脚本自身同样强制上述两个标志，保留既有测试文件与 unit glob。旧 HTTP 用例保持跳过，不把跳过计作真实联网通过。缺失目标的旧 `test:flow` 别名已移除，不使用归档文档中的旧命令恢复旧协议流程。

## 命令影响与独立验收

日常本地联调使用 `pnpm run build:local`：当前源码输出至工程外 `~/Library/Application Support/Heymoro/local/weapp`，API 固定为 `http://127.0.0.1:3001`。仅该专用项目放宽本地 HTTP 校验并保留已选 AppID，不改源码发布配置或旧 R19；后端需单独使用正式 `dev:local` 入口保持运行。后端本地身份签发正常会话，不要求先配置真实微信；未配置模型时只验证浏览、选图、输入与草稿，不生成假作品。

| 操作 | 影响与边界 |
| --- | --- |
| `pnpm run test` | 运行本应用 Node 测试；强制关闭旧 HTTP 用例与 Corepack 隐式获取，不启动产品服务 |
| `pnpm run lint` | ESLint 检查 `src` 的 JS／JSX，不带 `--fix`，不构建；单独执行时不额外设置上述环境标志 |
| `pnpm run verify:local` | 串行执行本应用 test＋lint，失败即停止；不递归调用自身或 workspace 测试 |
| `pnpm run build:local` | 使用已安装编译器重建上述持续本地项目；不启动后台、不安装依赖、不改发布配置，不等于真机或模型验收 |
| 依赖安装（不属于默认检查） | 在 workspace 层单独安排；安装可能联网、写入依赖并执行生命周期脚本，需要独立确认，不是验证命令的隐含前置动作 |
| `pnpm run build`／`pnpm run build:weapp` | 调用现有 Taro 微信编译，使用构建配置并写入 `dist`；不是默认检查，不自动证明运行时、后端连通或真机通过 |
| `pnpm run dev`／`pnpm run dev:weapp` | 调用相同编译器并保持 watch 进程，持续写产物；需单独启动并管理进程生命周期 |
| HTTP 集成验证 | 单独确认目标、服务、身份和隔离数据范围后执行；本默认入口没有 HTTP 别名，不探测／代启后端，也不从历史说明推断本机配置 |
| 微信 Runtime／开发者工具／真机验证 | 显式选择构建产物与环境，分别检查平台行为、交互及联网；不以 Node 测试、宿主模拟或编译替代，不改变微信安全校验 |

这里不记录或宣称本机 env 的实际值。运行配置、服务接入及未验事项以正式资料和各次独立验证证据为准；默认检查不部署、不迁移数据。
