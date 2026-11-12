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

本轮开始核验时，GitHub 的 `personal/stable` 为 `ac1279a7535a424c3dc3b2f7a5b2913783fdf7e8`，比 NAS 的 `2f6a9c54` 多一个仅修改 `AGENTS.md` 维护链接的文档提交。本次 Runbook、AGENTS 和 README 更新后，GitHub `personal/stable` 当前为 `dab6a05c9786599fbdb512e23fbd722da0c75582`；从 NAS 的 `2f6a9c54` 到该 HEAD 共 6 个提交，变更文件仅为 `AGENTS.md`、`README.md` 和 `docs/PERSONAL_MAINTENANCE.md`，不包含 Runtime 或 `dist`。NAS 尚未同步这些文档提交；扩展管理器可能显示 Git 更新提示，由用户决定是否同步。

柏宝箱代码通过 Docker bind mount 从宿主机加载。更新这个 Git 目录不需要重新构建或拉取 SillyTavern Docker 镜像，也通常不需要重启 Server；更新完成后需要浏览器完整刷新，使新构建产物被加载。

## 2. GitHub Fork 分支职责

- 上游：[`baibai-git/ST-BaiBai-Tools`](https://github.com/baibai-git/ST-BaiBai-Tools)，`main`。
- 个人 Fork：[`SurgeXW0508/ST-BaiBai-Tools`](https://github.com/SurgeXW0508/ST-BaiBai-Tools)。
- 个人 `main`：纯上游同步镜像，不放个人 Runtime 策略。
- 个人 `personal/stable`：唯一生产部署分支。NAS 不安装个人 `main`，也不直接跟踪原作者仓库。

### 上游更新流程

1. 在 GitHub 将原作者 `main` 同步到个人 Fork 的 `main`。只更新镜像分支，不直接影响 NAS。
2. 对比上游新旧提交，检查与当前 ST Core、柏宝库的接口和生命周期影响。
3. 阅读 [ST canonical maintenance rules](https://github.com/SurgeXW0508/SillyTavern/blob/release/docs/personal-fork/MAINTENANCE_COMPATIBILITY.md)，完成 Capability Ownership Review。特别确认 Save Generate 仍然不装配，不恢复与 ST Core 重叠的生成生命周期或 Vertex Adapter。
4. 在独立候选分支验证变更。源码有变化时，从锁文件安装依赖，运行受影响测试、`npm run test:personal-stable` 和必要的相邻测试，再执行生产构建 `npm run build`。
5. `manifest.json` 指向的运行时代码是 `dist/index.js`。源码修改后必须重新构建并将正确的 `dist` 与源码一起提交到候选分支；不要只提交 `src` 而遗漏构建产物。
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

## 6. 代码任务结束时的部署交接

凡任务修改了柏宝箱 Runtime、构建产物、依赖或与 ST/柏宝库的集成，完成实现、测试和独立审查后，必须在交接结尾明确：

1. 本次变更是否影响 NAS Runtime；纯文档/测试变更应明确说明无需更新 NAS。
2. 变更是否已进入 `personal/stable`；若尚未进入，不能声称可以直接部署。
3. 当前 NAS 预计从哪个 commit 更新到哪个 commit，以及该差异是否包含 Runtime/`dist` 变化。
4. 主动询问用户是否现在更新 NAS；如果确认，给出通过酒馆扩展管理器更新和完整刷新页面的步骤。

只提供更新建议，不自动更新 NAS、不自动重启或修改生产环境；必须取得用户明确授权后才能执行部署操作。
