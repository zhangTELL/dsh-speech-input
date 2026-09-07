# dsh-speech-input — DeepSeek Harness 语音输入插件

DSH Web GUI 聊天输入框右下角新增「语音」按钮（麦克风）：点击即可录音并转成文字填入输入框，支持长按空格键说话（Push-to-Talk）。插件提供两种语音转写引擎，默认使用本机 FunASR，也可以切换回智谱 GLM-ASR 云端。

## 能力

- 麦克风按钮一键开始/停止识别（识别中红色脉冲动画 + 「聆听中」浮标）
- 长按空格说话：按住说话，松开停止；短按空格仍输入普通空格
- 识别文本按「追加到输入框末尾 / 替换输入框内容」两种模式写入草稿
- 双识别引擎可切换：
  - **本地 FunASR**（默认）：通过 FunASR OpenAI 兼容服务转写，音频不出本机，无需 API Key
  - **智谱云端**：使用智谱 GLM-ASR-2512 转写，需要配置智谱 API Key，音频会发送到智谱
- 支持普通话、英语、粤语、日语、韩语等多种语言（由模型自动检测）
- 错误提示：麦克风权限被拒、没有听到声音、FunASR 服务未启动、智谱 Key 无效等中文提示浮条
- 宿主侧公告：向 agent 注册插件说明，用户提到「语音输入」时 agent 知道如何配合

## 使用场景

### 方式一：本地 **[FunASR](https://github.com/modelscope/FunASR)**

FunASR 官方提供 OpenAI 兼容 API，插件通过 DSH 宿主代理把浏览器录到的 WAV 转发到本地服务，因此浏览器不需要处理 CORS，音频也不会上传到云端。

启动 FunASR 服务（CPU 即可满足日常转写）：

```bash
pip install funasr fastapi uvicorn python-multipart
git clone https://github.com/modelscope/FunASR.git
cd FunASR/examples/openai_api
python server.py --model sensevoice --device cpu --port 8000
```

也可以用 Docker：

```bash
cd FunASR/examples/openai_api
docker compose up --build
```

然后在插件的「语音输入设置」中：

- 识别引擎选择「本地 FunASR」
- FunASR 服务地址填 `http://127.0.0.1:8000`
- FunASR 模型按需选择：`sensevoice`、`paraformer`、`paraformer-en`、`fun-asr-nano`
- 默认开启「切换/开始录音时自动启动 FunASR 服务」
- 已默认目录，如果不是这个目录，或想用 Docker/其他脚本启动，可在设置里修改启动命令和工作目录
- 不想让插件自动拉起进程时，取消「自动启动」即可，插件只连接你手动启动的服务

### 服务生命周期

- **打开 DSH 不会启动服务**，只有第一次语音转写时才由插件拉起（懒启动）
- 每次转写前先探测服务状态，已在运行就直接复用，不会重复启动
- **默认闲置 10 分钟后自动退出**，释放内存（本地模型常驻约 2.8 GB）；下次说话会重新拉起，有 3–30 秒冷启动延迟
- 闲置时长可在设置里改为 3 / 5 / 10 / 30 / 60 分钟，或设为「永不退出（常驻）」
- 插件停用（DSH 退出）时会回收自己拉起的进程，不再残留后台进程
- 自动退出生效范围：**只回收插件自己启动的服务**。手动启动的服务插件拿不到 pid，不会去动它


### 方式二：智谱云端（可选）

如果你已有智谱开放平台账号，或者暂时不想在本地装 FunASR：

- 在设置中把识别引擎切到「智谱云端」
- 填写智谱 API Key（保存到 DSH 配置目录，重启不丢失）
- 录音音频会发送到智谱进行转写，单次录音最长 30 秒

## 安装到 DSH

```bash
dsh plugin --profile web add link:D:\dsh\dsh-speech-input
# 重启 dsh web（如 D:\dsh\restart-dsh-web.ps1）后生效
```

挂载走 `cordis.patch.yml` + profile 机制（bundle 层 insert），不修改 DSH 源码。

## 开发

```bash
pnpm install      # 安装构建依赖
pnpm build        # tsdown 产出 lib/index.js（宿主）+ lib/client.js（浏览器）
pnpm typecheck    # tsc --noEmit
```

## 技术说明

- 浏览器用 `MediaRecorder` 录音，再转成 16kHz 单声道 WAV
- FunASR 模式：浏览器 POST 到宿主 `/dsh-speech-input/transcribe`，宿主转发到本地 `/v1/audio/transcriptions`
- 智谱模式：浏览器直接调用智谱 `/audio/transcriptions`
- 识别为「录完一段 → 一次转写」，暂不提供浏览器侧边说边出的中间结果
- 偏好存浏览器 localStorage（键 `dsh.speechInput.v1`），换浏览器/清数据即重置

## 限制

- FunASR 本地服务需要手动启动；首次运行会下载模型，第一次转写也可能有加载延迟
- 单次录音：智谱云端最长 30 秒（同步接口限制），本地 FunASR 放宽到 5 分钟
- FunASR 本地质量取决于所选模型；CPU 可以跑，GPU 能显著降低延迟
- 识别语言由模型自动检测，不再需要手动选择语言


### 其它已知行为

- 录音结束后会先显示「转写中…」，本地模型冷启动可能需要十几秒。
- 在麦克风授权完成前就点停止，插件会等录音器建好后立即收尾，不会卡到时长上限。

## 仓库

https://github.com/zhangTELL/dsh-speech-input
