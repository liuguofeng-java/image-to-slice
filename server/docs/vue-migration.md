# Vue 独立应用迁移

原页面恢复的逐项映射、截图与尚未复原项见 [原页面迁移对照与验收](vue-parity.md)。构建通过不代表界面和操作已全部等价。

## 应用入口

`index.html → src/ui/main.ts → App.vue`，共享一个 Pinia 实例。旧业务 app.js、页面模板、HTML 拼接脚本和 ImageToSliceVue 组件桥接已删除。Canvas 由组件 ref 与生命周期管理；切图列表、图像编辑器和重新生成审阅直接挂载。

## 状态与流程归属

- 工作区、图片、切图、选择、撤销重做：`stores/workspace.ts`。
- 图像编辑提交及几何冲突校验：`composables/use-image-editor.ts`。
- 远程批量重新生成、确认、取消、失败重试：`composables/use-regeneration.ts`。
- 上传/生成、画布、模型设置、历史、AI 拆图、HTML：对应 Vue 组件。
- 共用算法保持单一 JS ESM 实现，接口声明隔离历史可选字段；新工作区、组件和 API 入口使用 TypeScript。
- AbortController、监听器、计时器和 DOM 引用不进入持久化数据。请求按工作区版本检查，提交失败恢复资产与撤销栈。

## 移除与保留

删除 Figma 插件、模拟器、插件清单、专用构建、捕获运行时、图层导入、.fig 导出与画板转 HTML。
`/api/design/capture-figma` 和 `/api/design/export-fig` 不再注册，返回 404；来源允许规则不再包含 Figma 域名。Playwright 仅保留为开发测试依赖。

保留设计图生成 HTML 的 `/api/design/reconstruct-h5` 及图片理解路由。生成文档在禁用脚本的隔离 iframe 中预览，清洗后方可载入；编辑通过组件持有的预览文档引用完成，下载资源独立运行。

本地模型、部署脚本、权重、虚拟环境和用户配置不迁移。历史仍为 v1，原存储路径不变，旧专用字段不参与 UI、不批量清理。裁边几何、透明图片、高分辨率元数据和 HTML 缓存继续保存与恢复。

## 命令与验证

`npm run dev` / `npm start`：API + Vue HMR；打开 http://127.0.0.1:4173/ 。
`npm run build`：类型检查和 Web dist；`npm run preview`：API + 生产构建预览。
开发和预览均代理相对 /api/*、/health 到本机 18787。缺少构建时 preview 明确报错。

`npm test` 保留共用算法、模型路由、裁边和编辑器测试，增加工作区事务/历史测试与已删除路由回归。
`npm run test:e2e` 直接访问根网页，通过真实按钮操作上传、框选、设置、历史、导出、编辑器与重新生成、HTML 编辑；模型响应和工作区存储全部模拟。截图输出 `test-results/vue-app/`。不依赖模拟器或旧全局函数，不发起计费请求。

开发前阅读 AGENTS.md；不要重新引入旧页面运行方式。
