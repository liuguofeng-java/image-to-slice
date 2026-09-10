# Image To Slice

Vue 3 + TypeScript + Pinia 独立网页应用，沿用 Node.js 本地 API。用于上传或生成设计图、拆分切图、处理素材，并导出切图资源或可编辑 HTML。界面保持浅色主题，不依赖插件或模拟器。

## 启动

所有 npm 命令在 `server` 目录执行。推荐 Node.js `22.22.2`（见 `.nvmrc`）。

```powershell
npm ci
npm run dev
```

打开 http://127.0.0.1:4173/ 。`npm start` 与 `npm run dev` 相同：同时启动本地 API（18787）和 Vite 开发服务器（4173）。修改 Vue 代码即时热更新；修改后端需重启。按 Ctrl+C 停止本次启动的两个服务。

生产预览：

```powershell
npm run build
npm run preview
```

`build` 先执行类型检查，再输出 `dist/index.html` 和静态资源；不生成插件产物。`preview` 同时启动 API 与构建后的网页，缺少构建时会提示先运行 build。单独启动 API 使用 `npm run api`。前端仅使用相对 `/api/*`、`/health`，由 Vite 代理到本机 API。

## 使用流程

1. 通过“本地图片”上传 PNG、JPEG、WebP，或使用文生图 / 图生图。图生图支持多张参考图与粘贴图片。
2. 点击“连续框选”建立切图；选择模式支持移动、右下角缩放、多选与列表重排。切图设置中可修改名称、位置、尺寸、圆角、类型与父级。
3. “AI 拆图”通过图片理解 API 分析普通切图、文字和背景；先确认背景与待移除区域，再明确执行远程背景还原。原始生成图与局部合成图都保留，便于比较选择。
4. “智能抠图 / 局部修复 / 高清化”直接打开同一个图像处理编辑器，支持连续处理、撤销重做和保存重试。边缘切除可设置四边透明留白，保存时按真实像素比例更新设计坐标；“还原位置”保持主体原始位置，不重复加偏移。
5. “导出切图包”输出图片与 manifest.json；图片保留实际像素，设计位置与大小写入清单。文字保留为结构化元数据。
6. “生成 HTML”使用图片理解 API 生成设计图的 HTML。预览位于禁用脚本的隔离 iframe，支持缩放、检查与编辑、重新生成和下载 HTML 资源包。缓存可随历史恢复；重新生成由用户确认触发。

“预览补齐”使用邻近颜色近似填补切图区域，仅用于画布查看，不是 AI 重绘。

## 标记与远程重新生成

底部书签星形图标用于标记 / 取消标记重新生成。仅图片类型可标记，多选自动跳过非图片及正在处理的项目。隐藏图片保留标记。

右上角“AI重新生成”显示当前设计图标记数量，先展示图片、像素、子级数量、API 和模型，用户确认后顺序调用远程图片生成 / 修补接口，可能计费。子级覆盖区按真实像素比例排除，并在同一次生成中补全父图；不会调用本地模型。

生成结果进入审阅窗口，用户明确“应用此图”才替换素材。设计坐标、层级、名称与显隐保持不变；返回任一边低于输入像素时禁止应用。模型尽量保持主体、构图、颜色与文字，但不承诺细节完全一致。应用前检测外部修改；失败回滚图片、元数据和撤销栈，保留候选供重试。取消或关闭后忽略迟到响应，远程服务仍可能已计费。

## 设置与历史

“设置”管理图片理解和图片生成 / 修补 API，两种图片任务共用当前配置。密钥保留在本机 `.local-provider-config.json`，不进入前端持久化 store 或工作区历史。

“切图记录”支持恢复、创建副本、备注、删除。仍沿用版本 1 工作区、原存储目录和配置文件；透明图、负数/小数位置、高分辨率元数据、标记与 HTML 缓存继续保存。迁移不批量清洗旧字段，不移动或删除任何真实记录。

工作区自动保存；失败显示“重试保存”。关闭含未保存状态的页面会提示。Ctrl+Z / Ctrl+Shift+Z 撤销重做，Ctrl+S 保存；空格拖动画布，Ctrl+滚轮缩放。

## 本地模型

### 一键部署本地模型

模型环境与普通 npm 环境分开部署。在 `server` 目录执行：

```bash
npm run local-models:setup
```

仓库已将三个模型应用固定为 Git submodule。首次克隆建议使用 `git clone --recurse-submodules <仓库地址>`；已有工作区可以运行 `git submodule update --init --recursive`。即使尚未手工初始化，部署脚本也会优先初始化已登记的 submodule。

运行 `npm run local-models:setup` 会把固定版本的源码、权重和两个互不冲突的 CPU 虚拟环境放在 `server` 同级目录：

```text
image-to-slice/
├─ server/
├─ sam2-main/
├─ IOPaint/
├─ Real-ESRGAN/
├─ .venv-sam2/
└─ .venv-local-image/
```

首次部署需要联网下载约 `380 MB` 模型权重和数 GB Python/Torch 依赖。下载支持断点续传并校验 SHA-256；再次执行会复用已经校验通过的源码、权重和虚拟环境。CPU 推理无需 CUDA，但处理较大图片时可能需要几分钟。

部署完成后会自动运行三项真实推理检查。也可以稍后单独检查：

```bash
npm run local-models:check
```

模型源码目录如果已经存在但来源不符，或包含部署产物以外的本地修改，部署脚本会停止且不会覆盖。需要重新部署时，请先自行备份并移走对应目录或虚拟环境。若 Python 3.10 没有注册为系统启动器，可以把 `LOCAL_MODELS_BOOTSTRAP_PYTHON` 指向它的可执行文件后再运行部署。

### 本地 SAM 2 智能抠图

默认从 `server` 相邻的 `../sam2-main` 查找 SAM 2，从 `../.venv-sam2` 选择 Python，并使用 CPU 与 `checkpoints/sam2.1_hiera_tiny.pt`。`npm start` 会按需管理持久 Python worker，不需要单独启动 Python 服务。

```bash
npm run sam2:check
```

检查会真实加载 tiny 模型，并执行一次三候选分割和一次连续提示点细化。自定义安装位置或 Python 时可设置：

```text
SAM2_ROOT=D:\project\image-to-slice\sam2-main
SAM2_PYTHON=C:\path\to\python.exe
```

选中切图后点击底部 **智能抠图**。左键添加主体点，`Alt+单击` 添加排除点；也可以切换 Lab 色域魔棒、保留/排除画笔，并调整填洞、扩展/收缩、羽化与边缘去杂色。SAM 2 不可用时，魔棒和画笔仍可独立使用。

### 本地局部修复与高清化

局部修复默认从相邻的 `../IOPaint` 加载 LaMa，高清化从 `../Real-ESRGAN` 加载动漫 6B 模型，Python 默认来自 `../.venv-local-image`。两者都由 `npm start` 按需启动并复用同一个 CPU worker，不需要另开端口：

```bash
npm run local-ai:check
```

默认权重位置：

```text
D:\project\image-to-slice\IOPaint\models\big-lama.pt
C:\Users\<用户名>\.cache\torch\hub\checkpoints\big-lama.pt
D:\project\image-to-slice\Real-ESRGAN\weights\RealESRGAN_x4plus_anime_6B.pth
```

LaMa 会优先读取 IOPaint 项目中的 `models/big-lama.pt`，不存在时再检查用户缓存目录。

也可以通过 `IOPAINT_ROOT`、`REALESRGAN_ROOT`、`LOCAL_IMAGE_PYTHON`、`LAMA_MODEL_PATH` 和 `REALESRGAN_MODEL_PATH` 覆盖。检查命令会分别执行一次真实 LaMa 修复和 Real-ESRGAN 2× 推理；某个模型缺失时会继续检查另一个模型，并逐项报告结果。

选中切图后点击底部“局部修复”或“高清化”。红色蒙版表示待移除区域；高清化支持 2× / 4×，增加真实像素而不改变设计位置与尺寸。可连续处理，最后保存一次；取消和关闭会忽略迟到响应。

## 开发与验证

```powershell
npm test
npm run test:e2e
npm run build
git diff --check
```

首次运行浏览器测试需 `npx playwright install chromium`。Playwright 仅用于测试，不是应用运行依赖。端到端测试直接访问 Vue 根页面，拦截所有 API、使用内存历史和可控模型响应，不读取真实历史或调用计费 API；截图写入忽略的 `test-results/vue-app/`。

应用入口为 `src/ui/main.ts` 和 `App.vue`，工作区归 `stores/workspace.ts` 所有，任务控制器由 `stores/ai-tasks.ts` 管理但不持久化，图像编辑与批量流程在 composables，复用算法在 services/state。前后端共用纯函数使用显式 ESM，Node 保留 CommonJS 服务入口。

原插件、模拟器、图层导入、.fig 导出、画板转 HTML 和旧页面拼接链路已移除。设计图生成 HTML 业务保留；`index.html` 仅为 Vite 挂载入口。
