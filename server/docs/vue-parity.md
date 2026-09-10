# 原页面迁移对照与验收

基准：`e9685a1`。目标是恢复原页面和操作，不恢复 Figma，不把旧 HTML 或 `app.js` 作为 Vue 外壳。

## 对照方法与边界

- 对照提交内的 `ui.template.html`、`app.js`、`styles.css`、模型设置渲染器，以及现存共享几何、图像、层级、HTML 检查器算法。
- 正式运行：`index.html → main.ts → App.vue`，一个 Pinia；模板、事件、Canvas 与监听器均由 Vue 生命周期管理。
- 旧模板只在端到端测试的独立页面中做静态布局取证：去掉全部脚本，阻断所有网络请求，去掉 Figma 入口。不会执行旧插件代码，也不会进入 `dist`。
- 静态基准图不代表旧应用的动态行为已自动回放。交互使用 Vue 页面真实按钮及可控 API 响应验证；不以“有同名按钮”判定功能通过。
- 保留之前删除的 `.bat`、`.command`、“更多”、默认弹出框及 Figma 功能。未修改真实模型、权重、环境、密钥或历史文件；未重置、暂存或提交用户已有改动。

## 对照清单

表中组件均位于 `src/ui/components/`；测试名称对应 `tests/e2e/vue-migration.cjs`。共享单元测试位于 `tests/` 与 `tests/vue/`。

| 范围 | 原行为与恢复内容 | 当前实现 | 验收证据 |
| --- | --- | --- | --- |
| 页面外壳 | 原浅色主题、右上悬浮操作区、左侧 360px 切图区、底部图标栏；移除迁移新增页头与固定文字按钮墙 | `App.vue`、`app.css`、原 `styles.css` | 静态布局基准测试；桌面表单关键矩形误差不超过 2px，切图栏矩形相同 |
| 顶部入口 | AI拆图、缩放、原图层导入位置改“生成 HTML”、重新生成计数、设置、新工作、记录 | `App.vue` | 上传、HTML、重新生成、记录测试 |
| 生成默认值 | 9:16 手机屏，750 × 1334；六张比例卡的名称与像素说明 | `ImageSourcePanel.vue`、`emptyDraft` | `original source controls`，验证初始值与请求宽高 |
| 自定义比例 | 打开临时输入，整数 256–4096；取消不提交，确定后修改比例与请求 | `ImageSourcePanel.vue` | 804 × 2230 确认／取消测试 |
| 描述与参考图 | 字数计数；文生图／图生图显隐；参考图上传、拖放、连续粘贴、缩略图与预览 | `ImageSourcePanel.vue` | 粘贴两种事件、参考图数量、预览、远程请求引用数量断言 |
| 上传完成 | 显示设计图与切图栏，收起生成表单；多张结果保留切换 | `ImageSourcePanel.vue`、`App.vue`、workspace store | 上传与长图截图；多结果切换代码对照，未单列完整视觉用例 |
| 主画布查看 | 适应、100%、加减、鼠标滚轮；空格／中键平移；手动缩放不被尺寸监听覆盖 | `WorkspaceCanvas.vue`、共用 viewport helper | `canvas parity` 与长图四尺寸适应断言 |
| 框选与选择 | 连续框选；单选、Ctrl 多选、Shift 范围选择；选中条件控制底部操作 | `WorkspaceCanvas.vue`、`SliceAssetList.vue`、store | `Vue root`；空选无所选操作、非图片不可标记 |
| 移动和尺寸 | 拖动、8 个尺寸手柄、4 个圆角手柄、方向键 1px／Shift 10px | `WorkspaceCanvas.vue`、store | `canvas parity`：位置、宽度、圆角、撤销真实断言 |
| 还原位置 | 恢复初始位置；裁边后的初始点按已修复的像素／设计映射保存 | store、原 `slice-ai-state` | 裁边、小数与负数单元测试；画布还原测试 |
| 层级与重排 | 原倒序展示；只能同父级重排；拖放前后方向与显示顺序对应 | `App.vue`、原层级 helper | `hierarchical reorder`；隐藏子级元数据及顺序断言 |
| 显隐与导出 | 单图显隐、全部显隐、切图包和原图下载 | `App.vue`、`workspace-export` | 单图显隐、下载 ZIP 测试；高分辨率导出共用单元测试 |
| 快捷键 | Ctrl/Cmd+Z、Shift+Z／Y，Delete／Backspace，方向微调，画布 F／0／加减；输入框与弹窗不触发主区快捷键 | `App.vue`、`WorkspaceCanvas.vue` | 画布、编辑器快捷键隔离测试；部分组合为代码对照 |
| 切图属性 | 原右侧抽屉；单选／多选字段；每次字段提交即时保存，不要求额外“保存设置” | `SliceSettings.vue` | 名称、类型、X、圆角即时保存、撤销；批量删／撤销 |
| 属性保护 | 非图片清除重新生成标记；已完成 AI 图几何锁定；字段附近显示错误 | `SliceSettings.vue` | 非图片禁用；补齐后几何字段锁定测试 |
| 模型设置 | 原 520 × 680 设置面板、用途分组、自定义 API 选择器、测试状态、独立编辑框 | `ModelSettings.vue` | `floating panels`、`model picker keyboard` 及设置截图 |
| 超时时间 | 新配置默认 500 秒；读取已有 `timeoutSeconds`；提交 `timeoutMs` | `ModelSettings.vue` | 90 秒恢复、60 秒提交为 60000 毫秒 |
| 模型菜单 | 获取／筛选模型，键盘方向选择、Escape 返回触发器；保留密钥显示、删除、测试与保存入口 | `ModelSettings.vue` | 模拟模型列表及保存请求；真实密钥与真实连接测试未执行 |
| 历史 | 原左侧悬浮记录卡、恢复、创建副本、备注编辑、删除确认 | `WorkspaceHistory.vue` | 副本、恢复、刷新后标记／图像／隐藏子级不丢失；备注和删除仅代码对照 |
| 图片预览 | 原画笔／橡皮擦、笔刷粗细、AI补齐、保存、未保存关闭确认 | `SliceImagePreview.vue` | 橡皮擦像素变化、保存失败重试、撤销、不触发本地模型；蒙版远程请求路径代码对照 |
| 遮挡补齐 | 第一次红框预览不请求；再次确认远程修补，只合成蒙版范围 | `use-overlap-repair` | 请求次数、真实像素蒙版、蒙版外像素不变、保存失败回滚与重试 |
| AI 完整图保护 | 保留完整图，移动时创建／复用原始图副本；副本无旧处理缓存 | store、原 inpaint result helper | 补齐后方向键移动：原位置不变，新增副本移动，撤销恢复 |
| 旧处理变体 | AI 透明／SVG 图重新裁取前额外保留独立处理结果，不只依赖撤销 | store、画布及属性抽屉 | `workspace.spec.ts` 验证副本像素、高清元数据、位置及撤销；旧 SVG 分支为代码对照 |
| 图像编辑器 | 既有浅色智能抠图、候选结果、裁边、修复、高清化、连续处理与直接保存 | 原 `SliceCutoutEditor.vue`、`use-image-editor` | 候选切换、裁边→高清化、待修复提醒、修复、失败重试与撤销 |
| 裁边和高清数据 | 不改裁边算法；同尺寸画笔编辑不应清除裁边位置、原始源和高清像素密度 | 原几何 helper、`slice-edited-image` | `pixel-edit.spec.ts` 与原裁边状态测试 |
| 重新生成审阅 | 标记、数量、子级像素映射、处理前／后、显式应用、失败重试、取消迟到响应 | 原审阅组件与 `use-regeneration` | `remote regeneration`；模拟请求确实在途后取消，保存错误／进度四尺寸截图 |
| AI拆图 | 原大型背景范围窗，背景／覆盖区拖动缩放、数值、总圆角／四角手柄、前后任务切换、撤销 | `AiDecomposition.vue`、原背景 helper | 非空背景的尺寸校验、圆角、撤销与四尺寸截图；四角拖动、复杂批量生成尚未逐项自动化验收 |
| HTML | 大型隔离 iframe、缩放／平移、Elements 树、展开收起、检查器宽度、原布局详情与切图预览、编辑／下载／缓存 | `HtmlWorkspace.vue`、原 inspector helper | 隔离脚本、内容编辑、缓存不重复请求、ZIP 下载、树展开、四尺寸截图 |
| 保存和取消 | 请求不持久化控制器；提交检查资产／工作区；保存失败回滚并可重试；关闭取消异步响应 | store、各 composable | store 事务测试、编辑器／预览／补齐／重新生成回滚；迟到响应测试 |
| Vue 边界 | 单根、Pinia、ESM，不加载旧业务脚本，不用业务 `v-html`；Figma 路由 404 | `main.ts`、启动脚本、Node 路由 | `launch.cjs` 验证 dev HMR 连接、生产预览、代理和旧路由 404 |

## 截图索引

执行 `npm run test:e2e` 自动生成，截图是本机验收产物，不进入应用构建。尺寸：1920×1080、1280×800、800×600、390×844。

- `test-results/vue-parity/baseline-source-{width}.png` / `restored-source-{width}.png`：同基准的空页面。
- `test-results/vue-parity/baseline-long-{width}.png` / `restored-long-{width}.png`：同一张 804×2230 模拟长图。
- `test-results/vue-parity/references-1280.png`：连续参考图和预览入口。
- `test-results/vue-parity/settings-1280.png`、`model-api-1280.png`、`slice-settings-1280.png`、`history-1280.png`：各自原面板形态。
- `test-results/vue-app/editor-{width}.png`、`workspace-{width}.png`：220×80“探索民宿”小尺寸透明素材与编辑器。
- `test-results/vue-parity/decomposition-{width}.png`、`html-{width}.png`：拆图范围与 HTML 工作区。
- `test-results/vue-parity/regeneration-progress-{width}.png`、`regeneration-save-error-{width}.png`：模拟在途请求和保存失败状态。

## 尚未达到“完全原样”的项目

1. 窄屏保留了“图片与切图”收起入口和横向可滚动顶栏，390px 下切图抽屉最高 60vh。这是当前明确可见的响应式差异，不声称与旧窄屏逐像素相同。
2. HTML 保留迁移要求中的属性编辑，但放在原布局详情下的“编辑属性”折叠区；原 DOM 树语法着色、所有复杂页面的选区锁定细节尚未逐项复原验收。
3. 并非所有状态都有旧应用动态同帧截图。当前旧基准为隔离静态取证，桌面生成区与切图栏有数值比较；复杂拆图任务、历史备注／删除、所有键盘组合及跨平台字体仍需补充验收。

上述差异不能由 `npm test` 或构建通过来豁免。不要将本轮结果表述为“全部功能已逐像素一致”。真实模型服务测试未执行；所有生成与修补响应均模拟，未自动调用计费 API。

## 本轮验证结果

2026-09-10，本机 Windows：

- `npm test`：43 项 Node 测试、16 项 Vue/store 测试全部通过，类型检查通过。
- `npm run test:e2e`：15 项全部通过；包含开发 HMR 连接与生产预览代理检查。
- `npm run build`：通过，生成独立 Vue 网页产物。
- `git diff HEAD --check`、`git diff --check`：通过。Git 提示部分工作区 LF 将转换为 CRLF，未修改仓库换行配置，也未批量改写已暂存文件。
