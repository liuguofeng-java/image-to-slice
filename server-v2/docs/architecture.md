# 代码维护指南

## 从哪里开始读

前后端各自安装、构建，通过 HTTP 通信。不允许前端导入 `backend/src`，也不允许依赖旧 `server`。

| 文件 | 职责 | 修改时必须保留的约束 |
| --- | --- | --- |
| `frontend/src/App.vue` | 页面组合、项目入口、快捷键、抽屉 | 不直接改图片字节；输入框/弹窗内不触发画布快捷键 |
| `frontend/src/store.ts` | 项目状态、撤销、保存队列 | 持久化修改经过 `mutate`；快照不包含服务端版本号 |
| `frontend/src/components/EditorCanvas.vue` | Konva 渲染、鼠标交互 | 拖动中只更新节点，结束后一次提交；图片实例不进 store |
| `frontend/src/geometry.ts` | 原像素/设计坐标互换 | 不接收屏幕缩放倍率，正反变换必须互逆 |
| `frontend/src/useSplit.ts` | 框选会话、轮询、候选、应用 | 每次异步返回检查会话令牌；不自动重试分析 |
| `frontend/src/components/*Panel.vue` | 场景、图层、属性、候选的展示 | 调用 store/composable，不重复实现持久化 |
| `frontend/src/api.ts` / `types.ts` | 独立类型化 HTTP 客户端 | 密钥仅从设置输入发送，接口不读取已有明文密钥 |
| `backend/src/app.ts` | Fastify 初始化、安全检查、通用路由 | 默认回环监听、来源限制；无生产测试开关 |
| `backend/src/contracts.ts` | 请求 Schema 转换、响应白名单/OpenAPI | 私有密钥、幂等回执不进入公开响应 |
| `backend/src/split-routes.ts` | 拆图任务和事务性应用 | 回执 → 状态/版本/来源校验 → 裁片 → 原子提交 |
| `backend/src/storage.ts` | 唯一磁盘存储边界 | 图片不可变；项目串行锁；同目录临时文件原子替换 |
| `backend/src/provider.ts` | 远程视觉请求和模型结果解析 | 只使用后端配置 URL；不自动重试、禁用重定向 |
| `backend/src/domain.ts` | 数据校验、后端坐标及裁片位置 | 校验数量与尺寸；新图层继承源变换而非父子关系 |
| `backend/src/exports.ts` | 原密度导出、场景合成 | 输出不含画布缩放/选区；先限制分配面积 |

## 坐标与数据流

```text
鼠标屏幕坐标
  → 撤销画布平移/缩放：pointer()
  → 设计坐标
  → 撤销图片中心旋转、翻转、缩放：sourcePoint()
  → 原始 PNG 像素坐标
  → 向外取整/限制范围：normalizeRect()
  → 后端 Sharp 裁切
```

`Layer.x/y` 表示旋转前左上角，图片以中心旋转。`Layer.width/height` 是设计尺寸，`Asset.width/height` 是实际像素尺寸。不能混用；以后增加高清化或裁边也应维持这个约定。

## 保存和撤销

- `mutate` 是同步事务：先取内容快照，执行修改，校验，无实际变化不记录。失败恢复原内容。
- `epoch` 标识项目会话，`generation` 标识编辑代数；保存返回只能更新同一项目，不能将请求期间的新编辑标成已保存。
- `flight` 串行化自动保存和手动保存。后端的 `revision` 再防止不同标签页覆盖。
- 撤销只回退文档内容，不回退服务端 revision。应用服务端裁片使用 `accept`，不再重复发一次保存。
- 服务端只支持单进程访问同一数据目录。`serial` 不是跨进程分布式锁。

## 取消与幂等

AbortSignal 只是请求取消，不保证远程模型立即停止；前端 `serial` 令牌和后端任务状态共同忽略迟到结果。

分析与应用是两种操作：分析可能计费，只有明确点击才发起；应用裁现有原图，不再请求模型。应用重试必须保留 `operationId`，修改候选后才更换它。回执和项目在同一个文件内原子提交，防止成功后响应丢失造成重复图层。

## 格式与注释约定

- 源文件使用 UTF-8、LF、2 空格缩进；Prettier 负责 Vue、TypeScript、CSS、JSON 格式。生产压缩只发生在 `dist`，不要手工维护 `dist`。
- 两个工程均提供 `npm run format` 和 `npm run format:check`。打开 `server-v2` 为工作区并安装推荐的 Prettier 扩展后可保存时格式化。
- 注释解释坐标系、状态转换、并发保护、事务边界和设计原因，不逐行翻译代码。
- 增加外部字段时同步更新 `domain.ts`、`contracts.ts`、前端 `types.ts` 及接口测试；不要让两端共享源码来掩盖契约偏差。
- 行为重构先跑相应单测，再跑两端类型检查、全量测试、端到端与生产构建。模型测试必须注入假的响应，不通过真实 API 验证代码格式或重构。

## 最小回归选择

坐标改动看 `geometry.test.ts`、后端裁片像素测试、`canvas.spec.ts`；保存改动看 `store.test.ts` 和后端版本/失败回滚测试；拆图改动看 `provider.test.ts`、幂等/取消测试、`editor.spec.ts`；样式改动查看四种尺寸验收截图。
