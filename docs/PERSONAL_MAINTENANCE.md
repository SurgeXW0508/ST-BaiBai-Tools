# 柏宝箱 Personal Fork 维护与 NAS 更新

本文记录 `SurgeXW0508/ST-BaiBai-Tools` 的个人分支、构建、部署和回滚流程。跨项目能力归属、ST Core 与柏宝箱/柏宝库的兼容边界，以 [SillyTavern Personal canonical maintenance rules](https://github.com/SurgeXW0508/SillyTavern/blob/release/docs/personal-fork/MAINTENANCE_COMPATIBILITY.md) 为唯一来源；本文不复制能力冲突矩阵。

## 1. 安装与当前部署基线

柏宝箱是 SillyTavern 前端第三方 Git Extension，不是 Server Plugin，也不属于 ST Docker 镜像内部代码。

| 项目 | 当前确认值 |
| --- | --- |
| NAS 宿主机目录 | `/vol3/1000/SillyTavern/extensions/ST-BaiBai-Tools` |
| 容器内目录 | `/home/node/app/public/scripts/extensions/third-party/ST-BaiBai-Tools` |
| Docker 挂载 | 宿主机 `extensions` → 容器 `public/scripts/extensions/third-party` |
| Git origin | `https://github.com/SurgeXW0508/ST-BaiBai-Tools.git` |
| NAS 当前分支 | `personal/stable` |
| NAS 当前已安装 Runtime 基线 | `2f6a9c54d2c906b4a0e44d20c12d0712552e393d` |
| NAS 当前 tracking | `origin/personal/stable` |
| 2026-11-12 核验时工作区 | clean |

本轮开始核验时，GitHub 的 `personal/stable` 为 `ac1279a7535a424c3dc3b2f7a5b2913783fdf7e8`，比 NAS 的 `2f6a9c54` 多一个仅修改 `AGENTS.md` 维护链接的文档提交。本次新增/更新的 Runbook、AGENTS 和 README 也只包含文档内容；从 NAS 的 `2f6a9c54` 到本轮文档更新后的远端分支，差异文件仅限 `AGENTS.md`、`README.md` 和 `docs/PERSONAL_MAINTENANCE.md`，不包含 Runtime 或 `dist`。NAS 尚未同步这些文档提交；扩展管理器可能显示 Git 更新提示，由用户决定是否同步。后续维护时应实时读取远端 HEAD，不要把本文中的历史SHA当成当前分支头。

柏宝箱代码通过 Docker bind mount 从宿主机加载。更新这个 Git 目录不需要重新构建或拉取 SillyTavern Docker 镜像，也通常不需要重启 Server；更新完成后需要浏览器完整刷新，使新构建产物被加载。

## 2. GitHub Fork 分支职责

- 上游：[`baibai-git/ST-BaiBai-Tools`](https://github.com/baibai-git/ST-BaiBai-Tools)，`main`。
- 个人 Fork：[`SurgeXW0508/ST-BaiBai-Tools`](https://github.com/SurgeXW0508/ST-BaiBai-Tools)。
- 个人 `main`：纯上游同步镜像，不放个人 Runtime 策略。
- 个人 `personal/stable`：唯一生产部署分支。NAS 不安装个人 `main`，也不直接跟踪原作者仓库。

### 上游更新流程

> 酒馆、柏宝箱与柏宝库按三位一体自维护：上游有更新时严禁直接照搬（copy）合并，必须先对照三库自维护改动核验一致性与安全同步边界，设计好合入方案后再实施。

1. 在 GitHub 将原作者 `main` 同步到个人 Fork 的 `main`。只更新镜像分支，不直接影响 NAS。
2. 对比上游新旧提交与当前个人三库改动，检查与 ST Core、柏宝库的接口、钩子和生命周期一致性，先敲定安全合入方案再动手。
3. 阅读 [ST canonical maintenance rules](https://github.com/SurgeXW0508/SillyTavern/blob/release/docs/personal-fork/MAINTENANCE_COMPATIBILITY.md)，完成 Capability Ownership Review。特别确认 Save Generate 仍然不装配，不恢复与 ST Core 重叠的生成生命周期或 Vertex Adapter。
4. 在独立候选分支验证变更。源码有变化时，从锁文件安装依赖，运行受影响测试、`npm run test:personal-stable` 和必要的相邻测试，再执行生产构建 `npm run build`。
5. `manifest.json` 指向的运行时入口是 `dist/index.js`（浏览器固定挂载在 `/scripts/extensions/third-party/<扩展>/dist/index.js`，柏宝砚 Shadow Root 样式表按需加载同目录 `dist/index.css`）。`vite.config.mjs` 已按运行时挂载 URL 与 `manifest.json` 入口固定计算 `@sillytavern/*` 相对层级（`../../../../../`），不再依赖源码检出目录是否位于 `public/` 下（`FX3-1`）；源码修改后必须执行 `npm run build` 与 `npm run test:personal-stable` 核验真实交付入口（`dist/index.js`、`dist/index.css`）、17 个静态宿主模块白名单、动态宿主导入（`/scripts/world-info.js`）及异构目录构建字节一致性，再将正确的 `dist` 与源码一起提交到候选分支，不要只提交 `src` 而遗漏构建产物。
6. 审查通过后，将候选以正常 PR/快进方式推进到 `personal/stable`。不要 force-push、rebase 或重写已被 NAS 跟踪的公开 stable 历史。
7. 只有用户明确决定部署时，才通过酒馆扩展管理器更新 NAS。

## 3. 酒馆原生更新机制

柏宝箱安装在 SillyTavern 的第三方扩展目录，属于酒馆原生 Git Extension 管理范围。

当前 ST Personal 的扩展更新实现会：

1. 对该扩展目录执行 `git fetch origin`。
2. 读取本地当前分支。
3. 将本地 HEAD 与 `origin/<当前分支>` 比较。
4. 有更新时执行 `git pull origin <当前分支>`。

因此 NAS 必须保持以下关系：

```text
origin = https://github.com/SurgeXW0508/ST-BaiBai-Tools.git
current branch = personal/stable
tracking branch = origin/personal/stable
```

这能确保酒馆只检查和更新你的 Fork 的 `personal/stable`：

- 原作者更新后，只要你还没同步个人 Fork 的 `main`，NAS 不会因此显示可更新。
- 你只同步 Fork 的 `main`，但没有推进 `personal/stable`，NAS 仍不会显示更新。
- 只有你把已审查的提交推进到个人 `personal/stable` 后，酒馆才会发现该分支有新提交。
- 酒馆不会把原作者的 `main` 和你的 `personal/stable` 混合比较；更新目标由 NAS 的 origin 与当前分支共同决定。

酒馆中的 Git Extension 更新提示以 commit 为依据，不代表每个提交都含 Runtime 变化。文档-only 提交也可能显示更新；遇到这种情况先看提交差异，不要把提示直接理解为功能升级。

## 4. NAS 日常更新步骤

前置条件：本地扩展仓库 origin、当前分支和 tracking 必须与第 3 节一致，工作区无未提交修改。

1. 确认 GitHub 的 `personal/stable` 已包含本次通过审查的提交。
2. 打开 SillyTavern → 扩展管理/已安装扩展，找到 `ST-BaiBai-Tools`。
3. 点击该扩展的更新操作，等待更新结果和新 commit。
4. 完整刷新浏览器页面。若浏览器仍使用旧脚本，重新打开酒馆页面再验证。
5. 检查扩展已正常加载，并执行本次变更涉及的最小功能验证。

正常更新不需要：

- SSH 登录 NAS；
- 重建或更新 SillyTavern Docker 镜像；
- 进入 Docker 容器终端；
- 在 NAS 上运行 `npm install` 或 `npm run build`（构建产物应在发布到 stable 前生成并提交）。

若更新失败、工作区不干净、origin/分支不符或页面出现异常，停止继续操作并先核对 Git 状态；不要用重装扩展、删除目录或强制重置作为第一反应。

## 5. 回滚边界

- 首选在个人仓库创建经过审查的 revert commit，正常推进到 `personal/stable`，再使用酒馆原生更新器同步。
- 不 force-push、不重写 stable 历史，不通过把分支强行倒退来驱动客户端回滚。
- 回滚后完整刷新页面，并验证 Save Generate 仍未装配、相邻 ST Core 生成行为没有被改变。
- 柏宝箱回滚不等于回滚 ST Core 或柏宝库；三个仓库必须按兼容矩阵分别判断。

## 6. 与柏宝库的联动及使用边界

完整能力归属见 [SillyTavern Personal canonical maintenance rules](https://github.com/SurgeXW0508/SillyTavern/blob/release/docs/personal-fork/MAINTENANCE_COMPATIBILITY.md)，日常维护与使用注意以下五处运行期边界：

- **扩展路由改写与更新提示**：柏宝箱前端在将 `/api/extensions/*` 请求改写到柏宝库前，会先读取后端扩展管理配置确认 `interceptEnabled` 实际开启；若未安装柏宝库或后端关闭接管，自动回退酒馆原生扩展接口（配置接口发生非 `unsupported` 临时异常时进入 60 秒冷却期并沿用本地缓存状态，避免每次扩展操作重复等待超时）。当后端版本检查不可用时，浏览器兜底更新检查读取个人 Fork `SurgeXW0508/ST-BaiBai-Tools`（`personal/stable`）的 `manifest.json`，不再读取原作者 `main` 以免产生误报。
- **柏宝库早期桥接水合与统一 `fetchPipeline` True Feature Off**：启动时从 `window.__baibaokuEarlyBridge` 同步水合柏宝库权威开关（含 `fastCharacterListEnabled`、`tokenizerBulkCountEnabled` 等），并将柏宝库归属字段从前端 `extension_settings.baiBaiToolkit` 持久化中剥离以防陈旧配置闪烁；原死代码 `fastBootstrap.js` 与在酒馆 Personal Fork 下无实际作用的 `chatKeyboardScanReductionEnabled` 开关已退役下线。全部 10 处前端 `fetch` 拦截与柏宝砚动态保存观察槽位统一收敛至单一固定拓扑优先级管线 `src/features/fetchPipeline.js`（明文 JSON 观察槽恒在外层、保存 Gzip 与快表路由恒在内层，`0 -> 1` 挂载、`1 -> 0` 精确摘除），消除独立包装器反复开关导致的顺序反转或孤儿钩子残留；保存请求 Gzip 仅在压缩前异常或服务端明确返回 HTTP `400`/`415` 时回退未压缩重试，不对 `5xx` 或已发出后的网络中断重复投递。
- **主题懒加载耦合**：酒馆启动时的主题懒加载由“柏宝库剥离非当前主题 + 柏宝箱按需水合切换主题”共同完成。若在酒馆设置中禁用或移除柏宝箱，请完整刷新页面（柏宝库通过扩展目录 `mtimeMs` 与 30 秒 TTL 校验检测到柏宝箱未启用或已卸载时，会自动回退下发完整主题列表）。
- **Tokenizer 宏门控与滚动补丁隔离**：与柏宝库配对的 Tokenizer 预热宏跳过规则统一覆盖 `{{...}}` 与旧式 `<USER>/<BOT>/<CHAR>/<CHARIFNOTGROUP>/<GROUP>`（`FX2-2`），单一 `scrollTop` 写入注册表对各拦截器单独做异常隔离（`FX2-3`），详细归属见上述 ST canonical 规范。
- **内置柏宝砚（新版楼层管理器）使用与安全边界**：个人版已移除「跟随主 API」（`generateRaw`）改写路径，AI 标注改写须显式配置独立副 API 渠道（避免重叠请求污染酒馆全局 `max_tokens` 单例或将内置破限词发往 Google Vertex 生产账号），而手动编辑、查找替换、楼层筛选/跳转/隐藏/删除及楼层截图无需配置任何渠道即可直接使用。副渠道请求强制校验纯净 `http(s)://` 地址（拒绝内嵌凭据、查询参数与片段并自动剥离尾部 `/chat/completions` 或 `/models`）、识别非流式 HTTP 200 `{ error }` 错误信封及流式 SSE 尾行/JSON 回退，并采用采样参数白名单（`EXCLUDABLE_MODEL_PARAMS`）+ 固定凭据信封两阶段构造，禁止 `excludeParams` 删除 `custom_include_headers`、`reverse_proxy`、`proxy_password` 等路由认证字段，防止串用酒馆保存的 Custom / OpenAI 主密钥；共享渠道仓（`baibai_api_channels`）按消费者建仓协议初始化（空列表不写占位仓，兼容合并 `baibai_book` 与 `baibai_image` 旧渠道），其 API Key 明文保存在 `extension_settings` 中（会同步落入同用户目录的 `settings.json`、设置自动备份与柏宝库 `baibaoku/cache`，日常建议使用低权限或独立限额 Key，导出分享前先清理密钥）。手改、AI 审阅应用与查找替换均禁止空楼层保存、共用变更互斥锁，并绑定 `BoundChatTarget`（单聊强校验 `avatar_url + file_name` 与 `chat` 数组引用、群聊强校验 `id`，按需动态挂载观察槽并在 `stopPen()` 强制卸载）核验真实落盘及酒馆 `saveChatConditional` 布尔返回——等待锁或 `MESSAGE_EDITED` 等异步回调期间若切换至同名 `main` 等其他会话，绝不误认他人落盘成功或污染新会话 DOM/编辑态，失败时回滚内存文本/swipe 并完整保留草稿供重试（按上游设计不触发 `runOnEdit` 正则）；执行楼层隐藏/删除前会拦截酒馆原生 `#curEditTextarea` 未保存修改，楼层删除连带纳入前置 `tool_invocations` 载体系统层并固定以 `/del toolcalls=false <count>` 执行（落盘 HTTP 失败时仅在仍处原目标会话时调用 `reloadCurrentChat` 对齐，且自动清理命中已删楼层的后台改写任务）；世界书干跑（`checkWorldInfo(..., isDryRun=true)`）在聊天流式生成期间自动跳过，按最新楼层 `depth 0` 逆序扫描，优先读取 `baibai_exclude_settings`，不在调用前预写空占位槽并在同聊天非流式态下安全还原 `extensionPrompts['2_floating_prompt']`；若同时安装并启用独立版 `ST-BaiBai-Pen` / `ST-BaiBai-Inkwell`，内置版会自动让出并完整回收 Shadow Host、轮询定时器与运行态。

## 7. 大阶段收口时的部署交接

仅在**大阶段或完整大功能节点完成实现、测试与审查并具备部署评估条件**（或用户主动询问部署）时，在交接结尾明确：

1. 本次变更是否影响 NAS Runtime；若整项独立任务仅为文档/测试变更，简要说明无需更新 NAS 即可。
2. 变更是否已进入 `personal/stable`；若尚未进入，不能声称可以直接部署。
3. 当前 NAS 预计从哪个 commit 更新到哪个 commit，以及该差异是否包含 Runtime/`dist` 变化。
4. 询问用户是否现在更新 NAS；如果确认，给出通过酒馆扩展管理器更新和完整刷新页面的步骤。

在中间讨论、小功能子步骤、候选修复迭代或用户已明确延后统一发布的阶段内，无需机械重复附带上述部署提示。任何情况下只提供更新建议，不自动更新 NAS、不自动重启或修改生产环境；必须取得用户明确授权后才能执行部署操作。
