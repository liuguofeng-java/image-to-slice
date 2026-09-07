# Image To Slice

主应用位于 [`server/`](server/README.md)，SAM 2、IOPaint 和 Real-ESRGAN 以固定提交的 Git submodule 随仓库管理。

## 获取项目

```bash
git clone --recurse-submodules <仓库地址>
cd image-to-slice/server
npm install
npm run local-models:setup
```

已有工作区可以执行：

```bash
git submodule update --init --recursive
cd server
npm run local-models:setup
```

模型权重和两个 Python 虚拟环境是本机部署产物，不进入 Git。详细的安装、运行及自定义路径说明见 [`server/README.md`](server/README.md)。
