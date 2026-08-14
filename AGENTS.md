\# AGENTS.md



\## 项目背景



这是一个兆瓦级闪充站运营模拟器。



项目最初通过 ChatGPT Sites / Codex 创建，目前仍需保留 ChatGPT Sites 相关的运行和发布兼容性。



现在主要开发方式已经变为：



\* Windows 本地项目目录

\* WSL 运行 Node.js / npm

\* Git 和 GitHub 进行版本管理

\* Codex 用于继续开发和 UI 设计



除非用户明确要求，否则不要移除或破坏现有 Sites 兼容能力。



\## 当前开发环境



项目主要在 WSL 中运行。



开发服务器：



```bash

npm run dev

```



当前采用 Git worktree 同时运行两个版本：



\* `main`：原始版本，用于视觉对照，通常运行在 `localhost:3000`

\* `design/de-ai-ui`：UI 重构版本，通常运行在 `localhost:3001`



当前 Codex 应主要修改 `design/de-ai-ui`。



\## Git 使用约束



当前 Git worktree 是通过 Windows Git / PowerShell 创建的。



因此：



\* Git 操作优先使用 Windows Git / PowerShell

\* 不要依赖 WSL Git 操作当前 worktree

\* WSL 主要用于 npm、测试、构建和运行开发服务器



不要因为 WSL Git 无法识别当前 worktree 而修改 `.git` 文件或重建仓库。



\## `.openai` 与 Sites



`.openai/` 属于 Sites / hosting / 本地环境相关配置。



该目录被 Git 忽略是有意为之。



要求：



\* 不要提交 `.openai/`

\* 不要使用 `git add -f` 强制加入 `.openai/`

\* 不要把 `.openai/hosting.json` 中的实际值输出到聊天、日志、文档或提交信息

\* 不要擅自删除 `.openai/`

\* 不要因为主要改为本地开发就自动移除 Sites 支持



如果未来需要调整 Sites、Cloudflare、D1、R2、Worker 或 hosting 配置，应先分析并向用户说明，再修改。



\## 本次 UI 分支的目标



当前 `design/de-ai-ui` 分支的主要目标是重新设计 UI，降低现有界面的“AI 生成感”和模板感。



重点包括：



\* 更强的信息层级

\* 更成熟的排版

\* 更合理的信息密度

\* 减少不必要的卡片

\* 减少过大的圆角

\* 减少无意义的阴影

\* 减少装饰性图标

\* 减少不必要的 badge / pill

\* 减少模板化 SaaS Dashboard 风格

\* 使用排版、对齐、间距和分隔线建立层级

\* 提高专业工具软件和工程软件的感觉



\## UI 修改范围



UI 重构时应优先修改：



\* `app/components/`

\* `app/globals.css`

\* 页面布局相关 React 代码

\* 与纯视觉或交互表现相关的代码



除非确实必要，不要修改：



\* `.openai/`

\* `worker/`

\* `db/`

\* `drizzle/`

\* `build/sites-vite-plugin.ts`

\* `vite.config.ts`

\* Sites / Cloudflare 配置

\* 仿真算法

\* 车辆调度逻辑

\* 功率分配算法

\* SOC 计算

\* JSON 数据格式

\* CSV 导出格式

\* 现有业务逻辑



\## UI 重构原则



不要一次性推翻整个应用。



推荐流程：



1\. 先审计现有 UI。

2\. 找出最高影响的视觉问题。

3\. 提出多个设计方向。

4\. 选择一个方向。

5\. 建立统一视觉规则。

6\. 分区域、小步修改。

7\. 每次修改后检查真实浏览器效果。



不要仅仅因为代码可以编译就认为 UI 修改完成。



\## 验证



重要代码修改后根据情况运行：



```bash

npm run typecheck

npm run test

npm run build

```



UI 修改还应该通过实际浏览器检查：



\* 桌面端

\* 笔记本尺寸

\* 移动端



重点检查：



\* 信息层级

\* 字体

\* 对齐

\* 间距

\* overflow

\* wrapping

\* 响应式布局

\* 控件可用性

\* 是否仍然存在明显的 AI 模板感



