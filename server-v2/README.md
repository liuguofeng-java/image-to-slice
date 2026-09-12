# Slice Studio

独立的本地图片图层编辑器。以用户确认的 VberAI 编辑器范围为视觉参考，使用自有品牌和独立实现，不加载原站代码、私有 API，也不读取旧 `server` 的数据或密钥。

## 首次安装与启动

需要 Node.js **22.12 或更高版本**，建议使用 Node.js 22 LTS。开两个 PowerShell 终端分别启动：

后端：

```powershell
cd D:\project\image-to-slice\server-v2\backend
npm ci
npm run dev
```

前端：

```powershell
cd D:\project\image-to-slice\server-v2\frontend
npm ci
npm run dev
```

打开 **http://127.0.0.1:4174/editor**。后端服务为 **http://127.0.0.1:3002/health**。

不需要启动旧 `server`，不需要本地模型、Python、CUDA 或 VberAI 账户。前后端各有自己的依赖及锁文件，通过 HTTP 通信。安装器不创建 `.bat` / `.command` 入口。

默认配置可以直接运行。需要自定义时，将各自 `.env.example` 复制为 `.env` 后修改：前端 `VITE_API_BASE_URL` 指向独立 API；后端 `PORT`、`HOST`、`ALLOWED_ORIGINS` 管理本机端口和来源。后端拒绝非回环监听；改变前端访问来源时必须同步设置允许来源。前端环境变量会进入网页产物，**不要填写密钥**。

前端 `.npmrc` 固定 `legacy-peer-deps=true`，避免当前 npm 10 的 Vitest 可选 peer 解析错误；锁文件保存完整依赖版本。

## 使用流程

1. 文件菜单新建或打开项目，点击项目名称可重命名。场景支持新建、双击重命名、切换、删除。
2. 底部图片图标导入 PNG / JPEG / WebP，也可以拖放或粘贴。单张最大 30 MB、单边 16384 px、总面积 3200 万像素。后端校验真实内容并应用 EXIF 方向。
3. 在画布或图层列表选择图片；Shift / Ctrl 多选。拖动画布选框批量选择；图层行可拖动排序，并支持显隐和锁定。
4. 通过八方向控制点、旋转手柄或右侧参数编辑图片；支持翻转、透明度、圆角、对齐和等距分布。
5. 导出所选 PNG、ZIP 或场景 PNG。选中图层导出按原图像素密度保留细节，与屏幕缩放无关；非等比变换后的输出保持设计比例，场景 PNG 按场景设计尺寸导出。

快捷键：`V` 选择、`H` 平移、空格临时平移、滚轮缩放、`0` 适应画布、`Ctrl+S` 保存、`Ctrl+Z` 撤销、`Ctrl+Shift+Z` / `Ctrl+Y` 重做、`Ctrl+D` 复制、`Ctrl+A` 全选、Delete 删除、方向键移动 1 px（Shift 为 10 px）。文本输入和弹窗内不触发画布快捷键。

窄于 960 px 时左右面板变为互斥抽屉，底部两侧按钮打开面板，关闭后焦点回到入口。

## AI 框选拆图

首次点击右上角设置，输入独立的图片理解 Base URL、API Key、模型和超时秒数。支持 OpenAI-compatible `GET /v1/models` 与 `POST /v1/chat/completions` 图片理解；例如 Base URL 可填 `http://localhost:8080`。是否支持图片取决于所选模型和服务提供方，获取到模型名称不代表它一定支持视觉。点击“测试图片理解”前会提示可能计费。

选中单张可见、未锁定图片 → AI 框选拆图 → 在图片内框选局部或选择整图 → 确认发送范围及费用 → 开始分析 → 调整候选 → 创建图层。

- 候选最多 200 个，可启用/排除、改名、删除、拖动位置，通过 X/Y/W/H 修改原像素矩形；也可不用模型，直接手动添加候选。
- 矩形内部的背景、文字保留，不抠图、不补全遮挡、不重绘、不高清化。文字候选也是图片，不是可编辑文字。
- 最终始终裁原图。候选向外取整并限制在分析范围内；旋转、翻转、缩放通过源坐标映射，新图层保持原位且与原图独立。
- 原图保留，整批创建是一个撤销步骤。服务端使用版本检查、来源签名、原子提交和操作回执防止冲突、半套图层及重复提交。
- 不自动重试计费请求。取消、切换项目/场景、删除或修改来源后，旧候选不可应用。模型任务仅存在内存中，服务重启后须重新分析；尚未创建的候选不进入历史或自动保存。

## 保存、安全和备份

所有运行数据只写入 `backend/data`：

```text
data/
├─ projects/     # 独立项目 JSON、版本和幂等操作回执
├─ assets/       # 不可变 PNG 原图/裁片及像素元数据
└─ private/      # 图片理解配置及密钥
```

密钥仅留在后端文件，Windows 对 `private` 设置当前用户和 SYSTEM ACL；Unix 使用目录 0700 / 文件 0600。接口仅返回 `hasApiKey`，前端不接收旧密钥。它不是加密保险库：有本机用户权限的人仍可读取，请保护系统账户。

编辑后约 600 ms 自动保存；一次图像修改记一步撤销，视图缩放、面板开合不计入历史。撤销/重做栈仅存在本次页面会话内，刷新恢复已保存的项目而非历史栈。保存失败保留内存，点击右上角“保存失败”重试。多标签版本冲突返回 409，必须重新打开项目读取磁盘版本；放弃本地修改前有确认，不会悄悄覆盖另一页。

备份时停止后端，整体复制 `backend/data`。图片资源首期不自动清理，避免破坏撤销引用。不要提交 `data`、`.env`、`node_modules`、构建及测试产物；源码、锁文件、环境样例、文档和验收截图可以提交。

本服务仅限本机单用户，不适合直接暴露到公网。CORS / Host 校验用于减少浏览器跨站访问风险，不替代公网身份认证。

## 生产构建与预览

后端目录执行 `npm run build`，然后 `npm start`。前端目录执行 `npm run build`，然后 `npm run preview`，仍访问 4174。后端不托管前端；两个进程需要同时运行。不要同时运行同一端口的开发和生产进程。

## 验证

```powershell
# backend 目录
npm run typecheck
npm test
npm run build

# frontend 目录
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
npm run build
```

端到端测试启动专用端口 4175 / 3003 和临时测试目录，使用假的模型响应，不读取正式数据或真实密钥，也不调用计费服务。测试结束关闭专用服务；异常终止可能在系统临时目录遗留 `slice-studio-e2e-*` 测试文件。

接口契约见 [OpenAPI 文档](docs/openapi.json) 或运行中的 `/openapi.json`。功能与视觉范围见 [对照清单](docs/parity.md)，实测结果见 [验收记录](docs/verification.md)。

## 代码维护

源码已统一为多行格式，关键状态与坐标逻辑带有注释。前后端目录均可执行 `npm run format` 自动格式化，执行 `npm run format:check` 检查格式。模块职责、关键约束和回归路径见 [代码维护指南](docs/architecture.md)。
