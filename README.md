# Image To Slice

这是项目的总目录，实际的 Node.js 应用和 npm 命令都位于 [`server/`](server/README.md)。SAM 2、IOPaint 和 Real-ESRGAN 的源码以固定版本的 Git submodule 随项目提交；模型权重和 Python 虚拟环境在每台电脑上单独安装，不进入 Git。

## 新电脑首次安装

安装前请确认电脑具备：

- Git。
- Node.js `20.19.0` 或更高版本；推荐使用项目 `.nvmrc` 指定的 `22.22.2`。
- Python `3.10.x`。Windows 安装 Python 时需要包含 `py` 启动器。
- curl，以及至少 `8 GB` 可用磁盘空间。

先在 PowerShell 中检查版本：

```powershell
git --version
node --version
npm --version
py -3.10 --version
curl.exe --version
```

然后复制执行以下命令：

```powershell
git clone --recurse-submodules https://github.com/liuguofeng-java/image-to-slice.git
Set-Location .\image-to-slice\server
npm ci
npm run local-models:setup
npm start
```

各命令的作用：

- `git clone --recurse-submodules ...`：下载主项目以及三个固定版本的模型源码。
- `npm ci`：按锁文件安装 `server` 的 Node.js 依赖。
- `npm run local-models:setup`：在项目总目录生成两个 CPU Python 虚拟环境并下载模型权重；首次执行需要较长时间。
- `npm start`：启动本地 API 和网页。启动后打开 `http://127.0.0.1:4173/figma-sim.html`，使用期间不要关闭终端。

安装完成后的目录如下：

```text
image-to-slice/
├─ server/              # Node.js 应用；npm 命令在这里执行
├─ sam2-main/           # 已提交的 SAM 2 submodule
├─ IOPaint/             # 已提交的 IOPaint submodule
├─ Real-ESRGAN/         # 已提交的 Real-ESRGAN submodule
├─ .venv-sam2/          # 本机生成，不提交
└─ .venv-local-image/   # 本机生成，不提交
```

模型权重也属于本机部署文件，不会提交到 Git。部署结束后，`npm run local-models:setup` 会自动执行智能抠图、局部修复和高清化的真实检查。

## 已有项目更新或补装

如果项目已经克隆到电脑上，以 `D:\project\image-to-slice` 为例，在 PowerShell 中执行：

```powershell
Set-Location D:\project\image-to-slice
git pull --ff-only
git submodule sync --recursive
git submodule update --init --recursive
Set-Location .\server
npm ci
npm run local-models:setup
npm start
```

如果只需要更新 Node.js 应用且本地模型环境已经可用，可以跳过 `npm run local-models:setup`。重复运行该命令是安全的：已经校验通过的源码、权重和虚拟环境会被复用。

更完整的 Figma 插件安装、运行方式、模型检查和自定义路径说明见 [`server/README.md`](server/README.md)。
