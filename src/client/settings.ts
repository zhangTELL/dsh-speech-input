/**
 * 语音输入偏好与界面文案（简体中文，跟随全局偏好）。
 *
 * 偏好存浏览器 localStorage（键 dsh.speechInput.v1），不依赖宿主设置面，
 * 保持浏览器侧完全自包含；识别引擎、FunASR 服务地址/模型、插入模式、
 * 长按空格四项可配，另记忆最后一次使用的语言。
 *
 * 说明（2026-09 改为双引擎后）：
 *  - `engine` 可选 `funasr`（本地 FunASR OpenAI 兼容服务）或 `zhipu`（智谱云端）；
 *  - 语言由模型自动检测，`lang` 字段仅保留兼容旧数据，设置界面不再展示；
 *  - `continuous` / `interimFeedback` 同理保留兼容，不再影响行为；
 *  - 智谱 API Key 单独存 localStorage（键 dsh.speechInput.zhipuKey）。
 */
import {
  DEFAULT_FUNASR_IDLE_MINUTES,
  DEFAULT_FUNASR_MODEL,
  DEFAULT_FUNASR_START_COMMAND,
  DEFAULT_FUNASR_START_CWD,
  DEFAULT_FUNASR_URL,
} from './speech.ts'

/** 识别结果插入草稿的模式。 */
export type InsertMode = 'append' | 'replace'

/** 可选的语音识别引擎。 */
export type SpeechEngine = 'funasr' | 'zhipu'

/** 语音输入偏好。 */
export interface SpeechPreferences {
  /** 识别语言（BCP-47 标签，默认简体中文）。兼容字段，引擎自动检测。 */
  lang: string
  /** 识别文本插入草稿的方式：插入到光标位置 / 替换整个草稿。 */
  insertMode: InsertMode
  /** 连续识别：兼容字段，新实现为录音到手动停止。 */
  continuous: boolean
  /** 实时把中间结果写入草稿：兼容字段，新实现无中间结果。 */
  interimFeedback: boolean
  /** 按住空格说话（Push-to-Talk）：长按开始识别，松开停止；短按输入空格。 */
  pttEnabled: boolean
  /** 使用的语音识别引擎。 */
  engine: SpeechEngine
  /** 本地 FunASR OpenAI 兼容服务地址（engine === 'funasr' 时使用）。 */
  funasrUrl: string
  /** 本地 FunASR 模型别名（engine === 'funasr' 时使用）。 */
  funasrModel: string
  /** 是否在切换到本地 FunASR 或开始录音时自动启动服务。 */
  funasrAutoStart: boolean
  /** 自动启动 FunASR 服务时执行的命令。 */
  funasrStartCommand: string
  /** 自动启动命令的工作目录。 */
  funasrStartCwd: string
  /** 由插件自动启动的 FunASR 闲置多少分钟后自动退出；0 表示常驻不退出。 */
  funasrIdleMinutes: number
}

/** 可选的识别语言列表。 */
export interface SpeechLanguageOption {
  /** BCP-47 语言标签（传给 SpeechRecognition.lang）。 */
  id: string
  /** 中文显示名。 */
  label: string
}

export const SPEECH_LANGUAGES: readonly SpeechLanguageOption[] = [
  { id: 'zh-CN', label: '普通话（简体中文）' },
  { id: 'zh-TW', label: '國語（繁體中文）' },
  { id: 'yue-Hant-HK', label: '粵語（香港）' },
  { id: 'en-US', label: 'English（美国）' },
  { id: 'en-GB', label: 'English（英国）' },
  { id: 'ja-JP', label: '日本語' },
  { id: 'ko-KR', label: '한국어' },
  { id: 'fr-FR', label: 'Français' },
  { id: 'de-DE', label: 'Deutsch' },
  { id: 'es-ES', label: 'Español' },
  { id: 'ru-RU', label: 'Русский' },
  { id: 'pt-BR', label: 'Português（巴西）' },
  { id: 'it-IT', label: 'Italiano' },
  { id: 'ar-SA', label: 'العربية' },
]

/** 默认偏好（与宿主 schema 无关，纯浏览器侧）。 */
export const DEFAULT_PREFERENCES: SpeechPreferences = {
  lang: 'zh-CN',
  insertMode: 'append',
  continuous: true,
  interimFeedback: true,
  pttEnabled: true,
  engine: 'funasr',
  funasrUrl: DEFAULT_FUNASR_URL,
  funasrModel: DEFAULT_FUNASR_MODEL,
  funasrAutoStart: true,
  funasrStartCommand: DEFAULT_FUNASR_START_COMMAND,
  funasrStartCwd: DEFAULT_FUNASR_START_CWD,
  funasrIdleMinutes: DEFAULT_FUNASR_IDLE_MINUTES,
}

/** localStorage 键。 */
export const PREFS_KEY = 'dsh.speechInput.v1'

/** 上次使用的语言（会话内快捷记忆，独立于偏好主键）。 */
export const LAST_LANG_KEY = 'dsh.speechInput.lastLang'

/** 读取偏好；损坏或缺失时回退默认值。 */
export function loadPreferences(): SpeechPreferences {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw === null) return { ...DEFAULT_PREFERENCES }
    const parsed = JSON.parse(raw) as Partial<SpeechPreferences>
    const lang = typeof parsed.lang === 'string' && parsed.lang !== '' ? parsed.lang : DEFAULT_PREFERENCES.lang
    const insertMode: InsertMode = parsed.insertMode === 'replace' ? 'replace' : 'append'
    const engine: SpeechEngine = parsed.engine === 'zhipu' ? 'zhipu' : 'funasr'
    const funasrUrl = typeof parsed.funasrUrl === 'string' && parsed.funasrUrl.trim() !== ''
      ? parsed.funasrUrl.trim()
      : DEFAULT_FUNASR_URL
    const funasrModel = typeof parsed.funasrModel === 'string' && parsed.funasrModel.trim() !== ''
      ? parsed.funasrModel.trim()
      : DEFAULT_FUNASR_MODEL
    const funasrAutoStart = parsed.funasrAutoStart !== false
    const funasrIdleMinutes = Number.isFinite(parsed.funasrIdleMinutes)
      ? Math.max(0, Math.min(480, Math.trunc(parsed.funasrIdleMinutes as number)))
      : DEFAULT_FUNASR_IDLE_MINUTES
    const oldFunasrCommand = 'python server.py --model sensevoice --device cpu --port 8000'
    const funasrStartCommand = typeof parsed.funasrStartCommand === 'string'
      ? (parsed.funasrStartCommand === oldFunasrCommand ? DEFAULT_FUNASR_START_COMMAND : parsed.funasrStartCommand)
      : DEFAULT_FUNASR_START_COMMAND
    const funasrStartCwd = typeof parsed.funasrStartCwd === 'string' && parsed.funasrStartCwd.trim() !== ''
      ? parsed.funasrStartCwd.trim()
      : DEFAULT_FUNASR_START_CWD
    return {
      lang,
      insertMode,
      continuous: parsed.continuous === false ? false : true,
      interimFeedback: parsed.interimFeedback === false ? false : true,
      pttEnabled: parsed.pttEnabled === false ? false : true,
      engine,
      funasrUrl,
      funasrModel,
      funasrAutoStart,
      funasrStartCommand,
      funasrStartCwd,
      funasrIdleMinutes,
    }
  } catch {
    return { ...DEFAULT_PREFERENCES }
  }
}

/** 保存偏好（隐私模式等异常静默忽略）。 */
export function savePreferences(prefs: SpeechPreferences): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // 忽略。
  }
}

/** 记住上次使用的语言。 */
export function rememberLastLang(lang: string): void {
  try {
    localStorage.setItem(LAST_LANG_KEY, lang)
  } catch {
    // 忽略。
  }
}

/** 读取上次使用的语言。 */
export function readLastLang(): string | undefined {
  try {
    return localStorage.getItem(LAST_LANG_KEY) ?? undefined
  } catch {
    return undefined
  }
}

/** 界面文案（简体中文）。 */
export interface UiCopy {
  tooltipIdle: string
  tooltipListening: string
  tooltipUnsupported: string
  settingsTitle: string
  settingsDescription: string
  settingsEngine: string
  engineFunasr: string
  engineFunasrDesc: string
  engineZhipu: string
  engineZhipuDesc: string
  settingsFunasrUrl: string
  settingsFunasrUrlPlaceholder: string
  settingsFunasrUrlHint: string
  settingsFunasrModel: string
  settingsFunasrModelPlaceholder: string
  settingsFunasrModelHint: string
  settingsFunasrAutoStart: string
  settingsFunasrStartCommand: string
  settingsFunasrStartCommandPlaceholder: string
  settingsFunasrStartCommandHint: string
  settingsFunasrStartCwd: string
  settingsFunasrStartCwdPlaceholder: string
  settingsFunasrStartCwdHint: string
  settingsFunasrIdleMinutes: string
  settingsFunasrIdleNever: string
  settingsFunasrIdleMinutesOption: string
  settingsFunasrIdleMinutesHint: string
  settingsApiKey: string
  settingsApiKeyPlaceholder: string
  settingsApiKeyHint: string
  settingsInsertMode: string
  settingsInsertAppend: string
  settingsInsertReplace: string
  settingsPtt: string
  close: string
  listeningBadge: string
  transcribingBadge: string
  restartHint: string
}

export const UI_COPY: UiCopy = {
  tooltipIdle: '语音输入（点击开始；长按空格键说话）',
  tooltipListening: '录音中…（点击停止）',
  tooltipUnsupported: '当前环境不支持录音，请使用 Chrome / Edge / DSH Desktop',
  settingsTitle: '语音输入设置',
  settingsDescription: '选择本地 FunASR 或智谱云端作为语音转写引擎；单次录音最长 30 秒',
  settingsEngine: '识别引擎',
  engineFunasr: '本地 FunASR',
  engineFunasrDesc: '通过本机 FunASR OpenAI 兼容服务转写，音频不出本机',
  engineZhipu: '智谱云端',
  engineZhipuDesc: '使用智谱 GLM-ASR 云端转写，需要 API Key，音频会发送到智谱',
  settingsFunasrUrl: 'FunASR 服务地址',
  settingsFunasrUrlPlaceholder: 'http://127.0.0.1:8000',
  settingsFunasrUrlHint: '需要先启动本地 FunASR 服务（如 python server.py --model sensevoice --device cpu --port 8000）',
  settingsFunasrModel: 'FunASR 模型',
  settingsFunasrModelPlaceholder: 'sensevoice / paraformer / paraformer-en / fun-asr-nano',
  settingsFunasrModelHint: '默认 sensevoice，支持中文、英文、日文、韩文和粤语',
  settingsFunasrAutoStart: '切换/开始录音时自动启动 FunASR 服务',
  settingsFunasrStartCommand: 'FunASR 启动命令',
  settingsFunasrStartCommandPlaceholder: 'D:/dsh/FunASR/.venv/Scripts/python.exe server.py --model sensevoice --device cpu --port 8000',
  settingsFunasrStartCommandHint: '留空则不会自动启动；仍可通过服务地址直连已运行的服务',
  settingsFunasrStartCwd: '启动命令工作目录',
  settingsFunasrStartCwdPlaceholder: 'D:/dsh/FunASR/examples/openai_api',
  settingsFunasrStartCwdHint: '如果 server.py 不在 DSH 当前目录，请填写 FunASR 示例服务所在目录',
  settingsFunasrIdleMinutes: '闲置自动退出',
  settingsFunasrIdleNever: '永不退出（常驻）',
  settingsFunasrIdleMinutesOption: '闲置 {n} 分钟后退出',
  settingsFunasrIdleMinutesHint: '常驻约占 2.8 GB 内存；退出后下次说话会重新拉起（有冷启动延迟）。只对插件自动启动的服务生效',
  settingsApiKey: '智谱 API Key',
  settingsApiKeyPlaceholder: '粘贴智谱开放平台 API Key（open.bigmodel.cn）',
  settingsApiKeyHint: 'Key 保存在本机（DSH 配置目录，重启不丢失）；识别音频会发送给智谱服务',
  settingsInsertMode: '识别结果插入方式',
  settingsInsertAppend: '插入到光标所在位置',
  settingsInsertReplace: '替换输入框内容',
  settingsPtt: '长按空格键说话（松开停止；短按输入空格）',
  close: '完成',
  listeningBadge: '录音中…',
  transcribingBadge: '转写中…',
  restartHint: '设置将自动保存并在下次录音时生效',
}
