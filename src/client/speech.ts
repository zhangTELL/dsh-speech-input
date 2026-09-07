/**
 * 语音输入引擎（浏览器侧）：MediaRecorder 录音 + 可选 FunASR 本地 / 智谱云端转写。
 *
 * 背景：原实现使用 Web Speech API（SpeechRecognition），在 Electron（DSH
 * Desktop）中不可用——Google 仅向 Chrome/Edge 浏览器外壳提供该语音服务，
 * 其他 Chromium 外壳（含 Electron）拿不到 `window.SpeechRecognition`。
 * 故改为「录音 → 16kHz 单声道 WAV → 转写引擎」的通用链路，Web 端与
 * Desktop 端行为一致。
 *
 * 双引擎说明：
 *  - FunASR：浏览器先把 WAV 交给 DSH 宿主 `/dsh-speech-input/transcribe`
 *    路由，由宿主转发到本地 FunASR OpenAI 兼容服务，避免 CORS 与云依赖；
 *  - 智谱：浏览器直接调用智谱 `audio/transcriptions`，需要 API Key。
 *
 * 对外接口保持不变：`SpeechRecognizer` 构造签名与回调
 * （onUpdate / onSettled / onStatus）与旧版一致，UI 组件无需感知实现差异。
 * 语义差异（有意的）：
 *  - 识别为「录完一段 → 一次转写」，没有边说边出的中间结果（interim）；
 *  - 智谱同步接口限制：单段音频 ≤ 30 秒、≤ 25MB；
 *  - 语言由模型自动检测，`options.lang` 仅保留为兼容字段，不传给识别服务。
 */

import type { SpeechEngine } from './settings.ts'

/** 识别器当前状态。 */
export type SpeechStatus = 'idle' | 'listening' | 'transcribing' | 'error'

// ---------------------------------------------------------------------------
// 智谱 GLM-ASR 常量与 Key 存储。
// ---------------------------------------------------------------------------

/** 智谱语音转写端点（multipart/form-data）。 */
export const ZHIPU_ASR_URL = 'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions'
/** 智谱 ASR 模型编码。 */
export const ZHIPU_ASR_MODEL = 'glm-asr-2512'
/** 同步接口单段音频时长上限（毫秒）。 */
export const ZHIPU_MAX_DURATION_MS = 30_000
/** 同步接口单段音频体积上限（字节）。 */
export const ZHIPU_MAX_FILE_BYTES = 25 * 1024 * 1024
/** 识别请求超时（毫秒）。 */
export const ZHIPU_REQUEST_TIMEOUT_MS = 60_000
/** 宿主 FunASR 转发路由（浏览器 → DSH host → 本地 FunASR）。 */
export const FUNASR_TRANSCRIBE_ROUTE = '/dsh-speech-input/transcribe'
/** 本地 FunASR 服务默认地址。 */
export const DEFAULT_FUNASR_URL = 'http://127.0.0.1:8000'
/** 本地 FunASR 默认模型别名。 */
export const DEFAULT_FUNASR_MODEL = 'sensevoice'
/** FunASR 转写请求超时（毫秒）。 */
export const FUNASR_REQUEST_TIMEOUT_MS = 90_000
/** FunASR 本地服务无云端时长限制，录音上限放宽到 5 分钟。 */
export const FUNASR_MAX_DURATION_MS = 300_000
/**
 * 判定「录到的是静音」的峰值阈值（归一化 0~1）。
 * 实测 FunASR（SenseVoice + fsmn-vad）对衰减 37 倍的人声仍能正确转写，
 * 故把阈值压得很低：只有几乎全零的音频才会触发，避免误杀小声说话。
 */
export const SILENCE_PEAK_THRESHOLD = 0.001
/** 宿主 FunASR 状态检查路由。 */
export const FUNASR_STATUS_ROUTE = '/dsh-speech-input/funasr/status'
/** 宿主 FunASR 自动启动路由。 */
export const FUNASR_START_ROUTE = '/dsh-speech-input/funasr/start'
/** 默认 FunASR 自动启动命令（使用 uv 虚拟环境的 Python）。 */
export const DEFAULT_FUNASR_START_COMMAND = 'D:/dsh/FunASR/.venv/Scripts/python.exe server.py --model sensevoice --device cpu --port 8000'
/** 默认 FunASR 自动启动工作目录。 */
export const DEFAULT_FUNASR_START_CWD = 'D:/dsh/FunASR/examples/openai_api'
/**
 * 插件自动启动的 FunASR 闲置多少分钟后自动退出，默认 10 分钟；0 表示常驻。
 * 本地模型常驻约 2.8 GB，不用时退出可释放内存；下次说话会重新拉起（有冷启动延迟）。
 */
export const DEFAULT_FUNASR_IDLE_MINUTES = 10
/** API Key 的 localStorage 键。 */
export const ZHIPU_KEY_STORAGE_KEY = 'dsh.speechInput.zhipuKey'
/** 智谱 Key 的 host 侧持久化路由（同源相对路径，由宿主插件注册）。 */
export const ZHIPU_KEY_ROUTE = '/dsh-speech-input/key'
/** 录音最短有效时长（毫秒），短于此视为空输入。 */
const MIN_VALID_DURATION_MS = 400
/** 转写后 WAV 的目标采样率。 */
const WAV_SAMPLE_RATE = 16_000

/**
 * 读取智谱 API Key：优先从 host 持久化文件拉取（跨启动不丢），
 * 拉取失败时回退 localStorage 缓存。
 */
export async function loadZhipuApiKey(): Promise<string> {
  try {
    const response = await fetch(ZHIPU_KEY_ROUTE, { method: 'GET', cache: 'no-store' })
    if (response.ok) {
      const payload = (await response.json()) as { key?: string }
      const key = typeof payload.key === 'string' ? payload.key.trim() : ''
      if (key !== '') {
        try {
          localStorage.setItem(ZHIPU_KEY_STORAGE_KEY, key)
        } catch {
          // 忽略（隐私模式等）。
        }
        return key
      }
    }
  } catch {
    // host 不可达（如纯前端环境）时继续走 localStorage。
  }
  try {
    return localStorage.getItem(ZHIPU_KEY_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

/** 同步读取 localStorage 缓存中的 Key（无网络等待，供同步校验使用）。 */
export function loadZhipuApiKeyCached(): string {
  try {
    return localStorage.getItem(ZHIPU_KEY_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

/** 保存智谱 API Key：写入 host 持久化文件 + localStorage 缓存。 */
export function saveZhipuApiKey(key: string): void {
  const trimmed = key.trim()
  try {
    localStorage.setItem(ZHIPU_KEY_STORAGE_KEY, trimmed)
  } catch {
    // 忽略（隐私模式等）。
  }
  // 异步同步到 host（fire-and-forget；失败静默，下次输入会重试）。
  void fetch(ZHIPU_KEY_ROUTE, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: trimmed }),
  }).catch(() => {
    // 忽略（host 不可达等）。
  })
}

// ---------------------------------------------------------------------------
// 能力检测与错误映射。
// ---------------------------------------------------------------------------

/**
 * 当前环境是否支持语音输入。
 *
 * 旧语义为「是否支持 Web Speech API」；新实现以 MediaRecorder +
 * getUserMedia + AudioContext 为准（Electron 渲染进程与 Chrome/Edge 均具备），
 * 函数名保持兼容，UI 无需改动。
 */
export function isSpeechRecognitionSupported(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  return (
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof window.MediaRecorder === 'function' &&
    typeof window.AudioContext === 'function'
  )
}

/** 常见识别错误码 → 中文提示。 */
export const SPEECH_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  'no-key': '未配置智谱 API Key，请先点击设置按钮填写',
  'mic-denied': '麦克风权限被拒绝，请在系统/应用设置中允许麦克风后重试',
  'audio-capture': '没有检测到可用的麦克风，请检查设备连接',
  'too-long': `单次录音不能超过 ${ZHIPU_MAX_DURATION_MS / 1000} 秒，请分段录制`,
  'too-large': '录音文件过大（超过 25MB），请分段录制',
  empty: '没有识别到内容，请靠近麦克风再试一次',
  silent: '没有录到任何声音，请检查系统麦克风是否被其他程序占用、或输入设备是否选对',
  'invalid-key': '智谱 API Key 无效或额度不足（401），请检查设置',
  quota: '智谱 API 配额或余额不足，请到控制台查看',
  timeout: '识别请求超时，请检查网络后重试',
  network: '语音服务网络异常，请检查网络后重试',
  aborted: '识别已中断',
  'language-not-supported': '当前语言不受语音服务支持，请在设置中换一种语言',
  'bad-grammar': '语音语法配置错误',
  'funasr-not-configured': '未配置 FunASR 服务地址，请先在设置中填写本地服务地址',
  'funasr-offline': '无法连接本地 FunASR 服务，请确认 FunASR 服务已启动',
  'funasr-http': 'FunASR 服务返回异常，请检查模型名称和服务状态',
  'funasr-timeout': 'FunASR 转写请求超时，请检查本地服务是否响应',
  'funasr-start-failed': 'FunASR 自动启动失败，请检查启动命令和工作目录',
}

/** 未知错误码的兜底提示。 */
export const SPEECH_ERROR_FALLBACK = '语音识别失败，请重试'

/** 将识别错误码映射为中文提示。 */
export function speechErrorMessage(error: string): string {
  return SPEECH_ERROR_MESSAGES[error] ?? SPEECH_ERROR_FALLBACK
}

// ---------------------------------------------------------------------------
// 音频工具：webm/opus → 16kHz 单声道 WAV。
// ---------------------------------------------------------------------------

/** 把 PCM 采样编码为 WAV（44 字节头 + 16-bit PCM，单声道）。 */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const dataSize = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const writeString = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // PCM format
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeString(36, 'data')
  view.setUint32(40, dataSize, true)
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

/**
 * 复用的解码用 AudioContext。
 *
 * 原因：Chromium 对同一渲染进程可同时存在的 AudioContext 数量有硬上限
 * （约 6 个）。原实现每次录音都 `new AudioContext()`，在 DSH Desktop 这类
 * 长驻页面里，一旦其他模块也持有未释放的 AudioContext，后续录音就会在
 * 构造时抛异常、或拿到不可用的上下文，最终产出全零音频（表现为 FunASR
 * 侧 "empty speech"）。改为单例复用可彻底规避。
 */
let sharedDecodeContext: AudioContext | null = null

/** 获取（或重建）解码用的 AudioContext 单例。 */
function getDecodeContext(): AudioContext {
  if (sharedDecodeContext === null || sharedDecodeContext.state === 'closed') {
    sharedDecodeContext = new AudioContext()
  }
  return sharedDecodeContext
}

/**
 * 把 MediaRecorder 产出的 webm/opus blob 重采样为 16kHz 单声道 WAV。
 * 全程浏览器内完成（AudioContext + OfflineAudioContext），无网络依赖。
 */
async function webmToWav16k(blob: Blob): Promise<Blob> {
  const arrayBuffer = await blob.arrayBuffer()
  const ctx = getDecodeContext()
  const decoded = await ctx.decodeAudioData(arrayBuffer)
  const sourceRate = decoded.sampleRate
  const targetLength = Math.max(1, Math.ceil(decoded.length * (WAV_SAMPLE_RATE / sourceRate)))
  const offline = new OfflineAudioContext(1, targetLength, WAV_SAMPLE_RATE)
  const bufferSource = offline.createBufferSource()
  bufferSource.buffer = decoded
  bufferSource.connect(offline.destination)
  bufferSource.start(0)
  const rendered = await offline.startRendering()
  return encodeWav(rendered.getChannelData(0), WAV_SAMPLE_RATE)
}

/**
 * 计算 WAV（16-bit PCM）的归一化峰值。
 *
 * 用于在发送转写请求前识别「录到的是纯静音」：麦克风被系统/其他程序独占、
 * 权限给了空设备、或 AudioContext 异常时都会产出全零采样。此时发请求只会
 * 得到空文本，不如直接给出明确提示。
 */
async function wavPeak(wav: Blob): Promise<number> {
  const view = new DataView(await wav.arrayBuffer())
  const pcmLength = Math.floor((view.byteLength - 44) / 2)
  if (pcmLength <= 0) return 0
  let peak = 0
  for (let i = 0; i < pcmLength; i++) {
    const v = Math.abs(view.getInt16(44 + i * 2, true)) / 32768
    if (v > peak) peak = v
  }
  return peak
}

// ---------------------------------------------------------------------------
// 智谱 ASR 调用。
// ---------------------------------------------------------------------------

/** 调用智谱 audio/transcriptions，返回转写文本（失败抛出错误码）。 */
async function transcribeWithZhipu(wav: Blob, apiKey: string): Promise<string> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), ZHIPU_REQUEST_TIMEOUT_MS)
  try {
    const form = new FormData()
    form.append('model', ZHIPU_ASR_MODEL)
    form.append('file', wav, 'speech.wav')
    const response = await fetch(ZHIPU_ASR_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('invalid-key')
      if (response.status === 402 || response.status === 429) throw new Error('quota')
      if (response.status === 413) throw new Error('too-large')
      throw new Error('network')
    }
    const payload = (await response.json()) as { text?: string; error?: { message?: string } }
    if (typeof payload.text !== 'string') throw new Error(payload.error?.message ? 'network' : 'network')
    return payload.text
  } catch (error) {
    if (error instanceof Error && error.message === 'aborted') throw new Error('aborted')
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('timeout')
    throw error
  } finally {
    window.clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// FunASR 调用（通过宿主代理）。
// ---------------------------------------------------------------------------

/** 等待指定毫秒。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/** 查询宿主侧 FunASR 服务是否已就绪。 */
async function fetchFunasrStatus(baseUrl: string): Promise<boolean> {
  try {
    const endpoint = new URL(FUNASR_STATUS_ROUTE, window.location.origin)
    endpoint.searchParams.set('url', baseUrl.trim())
    const response = await fetch(endpoint.toString(), { cache: 'no-store' })
    if (!response.ok) return false
    const payload = (await response.json()) as { running?: boolean }
    return payload.running === true
  } catch {
    return false
  }
}

/** 请求宿主启动本地 FunASR 服务。 */
async function requestFunasrStart(
  baseUrl: string,
  model: string,
  startCommand: string,
  startCwd: string,
): Promise<void> {
  const endpoint = new URL(FUNASR_START_ROUTE, window.location.origin)
  endpoint.searchParams.set('url', baseUrl.trim())
  endpoint.searchParams.set('model', model.trim() || DEFAULT_FUNASR_MODEL)
  endpoint.searchParams.set('command', startCommand.trim())
  endpoint.searchParams.set('cwd', startCwd.trim())
  let response: Response
  try {
    response = await fetch(endpoint.toString(), { method: 'POST', cache: 'no-store' })
  } catch {
    throw new Error('funasr-offline')
  }
  let payload: { started?: boolean; running?: boolean; error?: string } = {}
  try {
    payload = (await response.json()) as typeof payload
  } catch {
    // 忽略非 JSON 响应。
  }
  if (!response.ok || payload.error) {
    if (payload.error === 'no-command') throw new Error('funasr-not-configured')
    throw new Error(payload.error || 'funasr-start-failed')
  }
}

/** 自动拉起本地 FunASR 所需的最小配置（偏好与识别器参数都满足）。 */
export interface FunasrStartOptions {
  funasrAutoStart: boolean
  funasrUrl: string
  funasrModel: string
  funasrStartCommand: string
  funasrStartCwd: string
}

/**
 * 在 FunASR 模式下开始转写前确保本地服务已启动。
 * 若用户关闭自动启动，则不做任何操作，直接尝试连接现有服务。
 */
export async function ensureFunasrStarted(options: FunasrStartOptions): Promise<void> {
  if (!options.funasrAutoStart) return
  if (await fetchFunasrStatus(options.funasrUrl)) return
  await requestFunasrStart(options.funasrUrl, options.funasrModel, options.funasrStartCommand, options.funasrStartCwd)
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await fetchFunasrStatus(options.funasrUrl)) return
    await sleep(500)
  }
}

/**
 * 调用 DSH 宿主转写路由，由宿主转发到本地 FunASR OpenAI 兼容服务。
 * @param wav - 16kHz 单声道 WAV。
 * @param baseUrl - FunASR 服务基础地址，如 http://127.0.0.1:8000。
 * @param model - FunASR 模型别名，如 sensevoice / paraformer。
 * @param idleMinutes - 闲置多少分钟后由宿主回收自动启动的服务；0 表示常驻。
 * @returns 转写文本；失败抛出错误码。
 */
async function transcribeWithFunasr(wav: Blob, baseUrl: string, model: string, idleMinutes: number): Promise<string> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), FUNASR_REQUEST_TIMEOUT_MS)
  try {
    const endpoint = new URL(FUNASR_TRANSCRIBE_ROUTE, window.location.origin)
    endpoint.searchParams.set('url', baseUrl.trim())
    endpoint.searchParams.set('model', model.trim() || DEFAULT_FUNASR_MODEL)
    // 告知宿主当前闲置退出策略，宿主据此刷新「最近使用时间」并调度回收。
    endpoint.searchParams.set('idle', String(idleMinutes))
    const response = await fetch(endpoint.toString(), {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: wav,
      signal: controller.signal,
    })
    if (!response.ok) {
      let code = 'funasr-http'
      try {
        const payload = (await response.json()) as { error?: string }
        if (typeof payload.error === 'string' && payload.error !== '') code = payload.error
      } catch {
        // 非 JSON 响应，使用兜底错误码。
      }
      throw new Error(code)
    }
    const payload = (await response.json()) as { text?: string; error?: string }
    if (typeof payload.text !== 'string') throw new Error(payload.error || 'funasr-http')
    return payload.text
  } catch (error) {
    if (error instanceof Error && error.message === 'aborted') throw new Error('aborted')
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('funasr-timeout')
    if (error instanceof TypeError) throw new Error('funasr-offline')
    throw error
  } finally {
    window.clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// 识别器。
// ---------------------------------------------------------------------------

/** 识别器回调集合（与旧版一致）。 */
export interface SpeechRecognizerHandlers {
  /**
   * 识别文本更新（新实现只在转写完成后调用一次）。
   * @param finalText - 已定稿文本。
   * @param interimText - 中间结果（新实现恒为空字符串）。
   */
  onUpdate(finalText: string, interimText: string): void
  /**
   * 一次识别结束（正常停止或出错）。@param text 最终累积文本。
   */
  onSettled(text: string): void
  /**
   * 状态变化（供 UI 展示）。
   * @param status 新状态。
   * @param message 错误时的中文提示（status === 'error' 时提供）。
   */
  onStatus(status: SpeechStatus, message?: string): void
}

/** 识别器构造参数（含双引擎配置）。 */
export interface SpeechRecognizerOptions {
  lang: string
  continuous: boolean
  interimResults: boolean
  engine: SpeechEngine
  funasrUrl: string
  funasrModel: string
  funasrAutoStart: boolean
  funasrStartCommand: string
  funasrStartCwd: string
  /** 插件自动启动的 FunASR 闲置多少分钟后自动退出；0 表示常驻不退出。 */
  funasrIdleMinutes: number
}

/**
 * 录音 + 转写识别器：点击/长按开始录音，手动停止（或 30s 自动截断）后
 * 转 16kHz WAV，再按所选引擎（FunASR 本地 / 智谱云端）完成转写，
 * 完成后经 onUpdate/onSettled 回传。同一时刻只允许一个活动实例。
 */
export class SpeechRecognizer {
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private startedAt = 0
  private stopping = false
  private aborted = false
  private pendingStop = false
  private durationTimer: number | undefined

  /**
   * 构造识别器。若环境不支持录音会直接抛出（调用方应先做能力检测）。
   * @param options - 兼容字段（lang/continuous/interimResults 保留但不再影响行为）。
   * @param handlers - 事件回调。
   */
  constructor(
    private readonly options: SpeechRecognizerOptions,
    private readonly handlers: SpeechRecognizerHandlers,
  ) {
    if (!isSpeechRecognitionSupported()) throw new Error('speech input is not supported')
  }

  /**
   * 开始录音。返回 false 表示启动失败（权限被拒 / 无麦克风 / 未配置 Key）。
   * Key 缺失时通过 onStatus('error') 给出中文提示。
   */
  start(): boolean {
    if (this.options.engine === 'zhipu' && loadZhipuApiKeyCached() === '') {
      this.handlers.onStatus('error', speechErrorMessage('no-key'))
      return false
    }
    if (this.options.engine === 'funasr' && this.options.funasrUrl.trim() === '') {
      this.handlers.onStatus('error', speechErrorMessage('funasr-not-configured'))
      return false
    }
    if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      this.handlers.onStatus('error', speechErrorMessage('audio-capture'))
      return false
    }
    void this.beginCapture()
    return true
  }

  /**
   * 打开麦克风。
   *
   * 显式关闭回声消除/噪声抑制/自动增益：这三者是为通话场景设计的，在部分
   * Windows 声卡驱动上会把麦克风输入整体压成静音（表现为转写恒为空）。STT
   * 场景应拿原始信号。若设备不接受这些约束，退回 `{ audio: true }`。
   */
  private async openMicStream(): Promise<MediaStream> {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      })
    } catch {
      return await navigator.mediaDevices.getUserMedia({ audio: true })
    }
  }

  /** 录音并启动识别器（异步：先等麦克风授权）。 */
  private async beginCapture(): Promise<void> {
    try {
      this.stream = await this.openMicStream()
    } catch {
      this.handlers.onStatus('error', speechErrorMessage('mic-denied'))
      return
    }
    if (this.aborted) {
      this.teardownStream()
      return
    }
    let mimeType = 'audio/webm;codecs=opus'
    if (typeof window.MediaRecorder === 'undefined') {
      this.handlers.onStatus('error', speechErrorMessage('audio-capture'))
      this.teardownStream()
      return
    }
    if (!window.MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = 'audio/webm'
    }
    try {
      this.recorder = new MediaRecorder(this.stream, { mimeType })
    } catch {
      // 个别环境不允许显式 mimeType，退回默认编码。
      this.recorder = new MediaRecorder(this.stream)
    }
    this.chunks = []
    this.stopping = false
    this.startedAt = Date.now()
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data)
    }
    this.recorder.onstop = () => {
      this.finishCapture()
    }
    this.recorder.start()
    this.handlers.onStatus('listening')
    // 竞态兜底：若在麦克风授权完成前用户就已请求停止，这里立即收尾，
    // 否则录音会一直持续到时长上限才结束。
    if (this.pendingStop) {
      this.pendingStop = false
      this.stopRecorder()
      return
    }
    this.durationTimer = window.setTimeout(() => {
      if (this.recorder !== null && this.recorder.state !== 'inactive' && !this.stopping) {
        this.stopping = true
        this.recorder.stop()
      }
    }, this.maxDurationMs())
  }

  /** 单次录音时长上限：智谱云端 30 秒，本地 FunASR 放宽到 5 分钟。 */
  private maxDurationMs(): number {
    return this.options.engine === 'funasr' ? FUNASR_MAX_DURATION_MS : ZHIPU_MAX_DURATION_MS
  }

  /** 停止录音器（若已创建且仍在运行）。 */
  private stopRecorder(): void {
    const recorder = this.recorder
    if (recorder === null || recorder.state === 'inactive') return
    try {
      recorder.stop()
    } catch {
      // 实例已停止等场景忽略。
    }
  }

  /** 录音结束：收拢音频、转 WAV、调用智谱、回传结果。 */
  private async finishCapture(): Promise<void> {
    if (this.durationTimer !== undefined) {
      window.clearTimeout(this.durationTimer)
      this.durationTimer = undefined
    }
    const recorder = this.recorder
    this.recorder = null
    this.teardownStream()
    if (this.aborted) return

    const elapsed = Date.now() - this.startedAt
    const recording = new Blob(this.chunks, { type: recorder?.mimeType ?? 'audio/webm' })
    // 录音过短 → 视为空输入，直接收尾（不调用识别）。
    if (elapsed < MIN_VALID_DURATION_MS || recording.size === 0) {
      this.handlers.onUpdate('', '')
      this.handlers.onSettled('')
      return
    }
    // 时长上限只对智谱云端生效（本地 FunASR 无此限制）。自动截断后 elapsed
    // 必然略大于上限，故这里留出 1 秒余量，避免误报「录音过长」。
    if (this.options.engine !== 'funasr' && elapsed > ZHIPU_MAX_DURATION_MS + 1000) {
      this.handlers.onStatus('error', speechErrorMessage('too-long'))
      return
    }
    try {
      const wav = await webmToWav16k(recording)
      if (wav.size > ZHIPU_MAX_FILE_BYTES) {
        this.handlers.onStatus('error', speechErrorMessage('too-large'))
        return
      }
      // 静音检测：全零音频发给识别服务只会得到空文本，且服务端日志里表现为
      // "empty speech"，难以定位。这里提前拦截并给出明确提示。
      if ((await wavPeak(wav)) < SILENCE_PEAK_THRESHOLD) {
        this.handlers.onStatus('error', speechErrorMessage('silent'))
        return
      }
      this.handlers.onStatus('transcribing')
      if (this.options.engine === 'funasr') await ensureFunasrStarted(this.options)
      const text = this.options.engine === 'funasr'
        ? (await transcribeWithFunasr(wav, this.options.funasrUrl, this.options.funasrModel, this.options.funasrIdleMinutes)).trim()
        : (await transcribeWithZhipu(wav, loadZhipuApiKeyCached())).trim()
      this.handlers.onUpdate(text, '')
      this.handlers.onSettled(text)
    } catch (error) {
      const code = error instanceof Error ? error.message : 'network'
      if (code === 'aborted') {
        this.handlers.onSettled('')
        return
      }
      this.handlers.onStatus('error', speechErrorMessage(code))
    }
  }

  /** 请求停止：停止录音并触发转写收尾。 */
  stop(): void {
    if (this.stopping) return
    this.stopping = true
    if (this.recorder === null) {
      // 麦克风授权尚未完成、录音器还没创建：记录待停止，等 beginCapture
      // 建好录音器后立刻收尾（否则这一轮会一直录到时长上限）。
      this.pendingStop = true
      return
    }
    this.stopRecorder()
  }

  /** 立即中断（如组件卸载），不触发转写。 */
  abort(): void {
    this.aborted = true
    this.stopping = true
    if (this.durationTimer !== undefined) {
      window.clearTimeout(this.durationTimer)
      this.durationTimer = undefined
    }
    try {
      if (this.recorder !== null && this.recorder.state !== 'inactive') this.recorder.stop()
    } catch {
      // 忽略。
    }
    this.teardownStream()
  }

  /** 释放麦克风轨道。 */
  private teardownStream(): void {
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
  }
}
