# SenseVoice STT for OpenChamber

把 cc-haha 已下载的 **SenseVoice Small (INT8)** 模型接到 OpenChamber 的“服务器”听写模式。
扩展自带一个常驻的本地 OpenAI 兼容转写服务，不依赖 cc-haha 进程。

## 安装

1. 打开 OpenChamber → **设置 → Extensions**。
2. 选择 **从文件夹安装**，指向本目录：
   `%USERPROFILE%\.config\openchamber\extensions-src\sensevoice-stt`
3. 安装时允许 **本地服务 (service)** 能力。
4. 打开扩展面板可随时查看配置说明。

## 配置 OpenChamber

**设置 → 语音 / 听写** → 识别方式选择 **服务器**：

| 字段 | 值 |
| --- | --- |
| 服务器地址 | `http://127.0.0.1:47831` |
| 模型 | `sensevoice`（任意非空值） |
| 端点路径 | 默认 `/audio/transcriptions`（也支持 `/v1/audio/transcriptions`） |
| API Key | 留空 |

## 工作方式

- 扩展声明了 `service.keepRunning: true`，随 OpenChamber 启动，host 通过
  `GET /health`（Bearer token）判断就绪。
- 固定监听 `127.0.0.1:47831` 提供 OpenAI 兼容接口：
  `POST /audio/transcriptions`、`POST /v1/audio/transcriptions`，接受 multipart
  `file` 字段（16 kHz 单声道 PCM16 WAV），返回 `{ "text": "..." }`。
- 首次转写时准备资源：
  - `model.int8.onnx` / `tokens.txt` 从 cc-haha 目录 **硬链接** 到
    `guest-data/sensevoice-stt/models`（同一磁盘时不额外占用空间）；
  - sherpa-onnx 运行时从 cc-haha 复制约 23 MB 到 `guest-data/sensevoice-stt/sherpa`。
- 之后即使 cc-haha 没启动、甚至被卸载，本服务仍可独立转写。
- 空闲 5 分钟后卸载模型释放内存，下次转写自动重载（约 2–4 秒）。

## 与 cc-haha 同时使用

可以。两边是独立进程，各自加载一份模型，读取同一份只读模型文件，互不影响。
代价是内存与 CPU 各占一份（每个已加载模型的进程约 400–600 MB RSS）。

## 可选配置

编辑：

```
%USERPROFILE%\.config\openchamber\guest-data\sensevoice-stt\config.json
```

支持字段：

```json
{
  "port": 47831,
  "modelDir": "C:\\Users\\<you>\\.claude\\cc-haha\\voice\\sensevoice\\models",
  "sherpaRuntime": "C:\\Users\\<you>\\.claude\\cc-haha\\voice\\sensevoice\\runtime\\1.13.8\\node_modules",
  "threads": 2,
  "language": "auto",
  "idleUnloadMs": 300000
}
```

修改后重启扩展服务（或在 Extensions 里暂停再启用）生效。端口变化后记得同步修改
OpenChamber 的服务器地址。

## 状态排查

- `http://127.0.0.1:47831/health` — 服务是否在跑、模型是否已加载。
- `http://127.0.0.1:47831/status` — 数据目录、模型路径、运行时路径、内存占用。
- 若端口被占用，服务仍会启动但 `sttError` 会说明原因；换端口请改 `config.json`。
