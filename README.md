# FFmpeg Workbench

面向日常视频处理的跨平台桌面应用原型，使用 Tauri 2、React、TypeScript 和 Rust。界面将常用 FFmpeg 参数整理为中文功能和可选择的配置，文件在本机处理。

当前原生桌面已在 macOS Apple Silicon 验证；Windows 和 Intel Mac 尚未完成同等范围的人工界面验收，Linux 尚无安装包。项目仍处于预览阶段，并未覆盖 FFmpeg 的全部参数。

## 下载安装

从 [GitHub Releases](https://github.com/wangchenv/ffmpeg-workbench/releases) 下载当前预览版：

| 平台 | 安装包 | 安装方式 |
| --- | --- | --- |
| macOS 11 及以上，Apple Silicon / Intel | `macOS-universal.dmg` | 打开镜像，将应用拖入“应用程序” |
| Windows 10 / 11，64 位 | `Windows-x64-setup.exe` | 按向导为当前用户安装 |

安装包不附带 FFmpeg，首次使用需在“处理引擎设置”选择本机引擎。Windows 缺少 WebView2 时，安装器需要联网下载该运行时。

当前预览包尚无正式发行签名：macOS 为临时签名且未公证，Windows 未签名；系统可能提示开发者或发行者无法验证。每次发布提供 `SHA256SUMS.txt` 供校验下载内容。

## 当前功能

- 六个功能入口：压缩视频、转换格式、截取片段、调整画面、提取音频、去除声音。
- 19 个常用控件和 28 项低频图形配置，支持按用途分类、检索及兼容性提示。
- MP4、MKV、MOV、WebM 视频输出，以及 MP3、WAV、FLAC 音频输出。
- 画质、尺寸、旋转、镜像、帧率、片段范围、音量、音频码率和采样率配置。
- 工程 JSON 保存与载入、本地自动保存、撤销修改；无法无损映射的复杂工程保留原始配置并限制修改。
- 本机引擎检测、媒体探测、原生文件对话框、串行任务队列和任务独立日志。
- 准备、处理、保存、完成四阶段进度，显示已用时间、预计剩余、速度、帧数和结果文件大小；支持取消和不覆盖已有文件的输出提交。
- 完成卡片提供“预览视频”和“打开所在文件夹”；支持应用内播放、暂停、拖动进度、音量和静音，音频结果可以直接试听。
- 默认收起的生成命令、配置检查和处理详情，便于核对实际执行内容。

## 使用流程

1. 在“处理引擎设置”中连接本机 FFmpeg。若启动超时，可主动选择“复制到应用缓存并连接”；原始引擎文件保留。
2. 选择一个功能，添加本地视频或音频，再调整效果。也可以使用内置的 5 秒无声测试画面。
3. 选择可写的输出位置，点击“开始处理”，在“处理任务”查看进度或取消。
4. 完成后点击“预览视频”或“试听音频”检查结果，点击“打开所在文件夹”定位输出。

预览直接读取本机成功任务的产物，不上传媒体。播放能力取决于平台支持的格式与编码；无法播放时会显示提示并提供文件夹入口。示例没有声音，音频功能需使用带声音的素材。

## 开发环境

- Node.js 22 或更新版本，以及 npm。
- Rust 工具链；项目声明的最低 Rust 版本为 1.90。
- 当前平台所需的 Tauri 2 开发依赖。
- 可运行的 FFmpeg；完整媒体测试另需 ffprobe。

安装依赖：

```sh
npm ci
```

启动桌面应用：

```sh
npm run desktop
```

仅预览前端界面：

```sh
npm run dev
```

浏览器预览地址为 `http://127.0.0.1:1420/`。本机文件选择、FFmpeg 执行和结果播放请使用桌面版。桌面启动脚本可以复用已运行的开发服务。

可复制 `.env.example` 为 `.env.local`，设置开发用的 FFmpeg 路径及示例输出位置。该配置不会上传到仓库。生产桌面版优先使用用户在界面中连接的引擎；仓库和应用包均不包含 FFmpeg 二进制。

## 构建

```sh
npm run build
# 在 macOS 构建通用 DMG，需先安装两个 Rust target
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run desktop:build -- --ci --target universal-apple-darwin --bundles dmg -- --locked
# 在 Windows 构建 x64 安装程序
npm run desktop:build -- --ci --target x86_64-pc-windows-msvc --bundles nsis -- --locked
```

桌面构建结果由 Tauri 写入 `src-tauri/target/`。安装包需在对应操作系统构建。GitHub 工作流会对 `main` 执行双平台构建检查；推送与源码版本一致的 `v*` 标签后，在两个平台均通过测试、打包及安装包检查的前提下发布预览 Release，同时上传两个安装包和 SHA-256 校验文件。

## 测试

前端与共享命令模型测试：

```sh
npm test
```

无需外部媒体引擎的原生测试：

```sh
cargo test --manifest-path src-tauri/Cargo.toml
```

完整原生测试与参数执行矩阵需要设置已安装引擎的绝对路径。例如，在 macOS 或 Linux shell 中：

```sh
export FFMPEG_PATH=/absolute/path/to/ffmpeg
export FFPROBE_PATH=/absolute/path/to/ffprobe
cargo test --manifest-path src-tauri/Cargo.toml -- --include-ignored
node --import tsx scripts/test-feature-matrix.ts
```

部分故障注入和进程管理测试仅适用于对应操作系统。测试生成的媒体与日志写入 `artifacts/test-evidence/`，不纳入源码版本控制。参数矩阵验证需要包含相应编码器、滤镜及封装器的 FFmpeg 构建。

`scripts/build-test-report.py` 是可选的本地报告工具，另需 Python、ReportLab 和本地测试证据；仓库不包含历史媒体、截图、测试报告或机器相关的原始记录。单元测试、命令行执行测试和原生界面验收分别记录，不能相互替代。

## 当前限制

- 功能化流程支持一个素材、一个普通本地输出；转换格式会重新编码。
- 网络输入、管道、设备采集、复杂滤镜图、多输出等仍属于后续规划；未知和复杂工程不能直接由当前功能面板执行。
- 图形设置并不保证任意素材和 FFmpeg 构建均兼容；画质倾向不保证固定文件大小。
- 任务队列仅保留于本次会话，窗口关闭会取消活动任务，不支持后台持久任务和崩溃恢复。
- 时长未知时不显示估算百分比；预计剩余时间会随实测速度变化。

完整产品目标与当前实现边界见 [产品与技术设计](docs/ffmpeg-gui-design.md)。

## 引擎与许可

本仓库不附带 FFmpeg。用户需提供自己的可执行文件，并按所用构建的许可处理分发；应用内的缓存复制仅针对用户已有的本机引擎。

仓库暂未附正式 `LICENSE` 文件。`src-tauri/Cargo.toml` 当前的包元数据标记为 `Apache-2.0`，仍需确认并统一应用源码的许可；本预览版不新增许可授权文件。
