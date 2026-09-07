/**
 * 语音输入按钮组（composer 右下角「conversation.input.right」席位）。
 *
 * 两个按钮：麦克风（点击开始/停止浏览器语音识别，实时把语音转成文字写入
 * 草稿）与设置（识别语言、插入模式、连续识别等偏好，存 localStorage）。
 * 识别失败/权限被拒时在按钮上方弹出错误浮条；浏览器不支持 Web Speech API
 * 时按钮禁用并给出换浏览器提示。组件只读草稿，写入一律走 inputActions。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  Button,
  IconCheckOutline16,
  IconSettingsOutline14,
  Modal,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import {
  UI_COPY,
  loadPreferences,
  savePreferences,
  type SpeechPreferences,
} from './settings.ts'
import {
  SpeechRecognizer,
  ensureFunasrStarted,
  isSpeechRecognitionSupported,
  loadZhipuApiKey,
  loadZhipuApiKeyCached,
  saveZhipuApiKey,
  type SpeechStatus,
} from './speech.ts'

/** 输入机状态的最小结构（本插件只读 draft）。 */
interface InputStateLike {
  draft: string
  draftRev: number
}

/** 公开输入动作面中本插件用到的成员。 */
interface InputActionsLike {
  setDraft(text: string): void
}

/**
 * 本插件对插槽合同的类型声明：conversation 包在运行时注册了
 * `conversation.input.right`（list/session，owner = { session, input }），
 * 这里按同形声明以便 register 做编译期校验（与 dsh-language-input 相同）。
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SessionStandardProps {
    /** 会话输入机状态选择器。 */
    useInput: <S>(sel: (s: InputStateLike) => S, eq?: (a: S, b: S) => boolean) => S
    /** 公开输入动作面。 */
    inputActions: InputActionsLike
  }

  interface SlotMap {
    'conversation.input.right': {
      kind: 'list'
      scope: 'session'
      owner: { session: unknown; input: InputStateLike }
    }
  }
}

/** 组件接收的 props 子集（运行时由框架注入完整标准套件）。 */
interface SpeechInputButtonProps {
  useInput?: <S>(sel: (s: InputStateLike) => S, eq?: (a: S, b: S) => boolean) => S
  inputActions?: InputActionsLike
  sessionId?: string
}

/** 脉冲动画 keyframes（只注入一次，用数据属性做 CSS 变量传值）。 */
const PULSE_KEYFRAMES = `
@keyframes dsh-speech-input-pulse {
  0% { box-shadow: 0 0 0 0 rgba(229, 72, 77, 0.45); }
  70% { box-shadow: 0 0 0 9px rgba(229, 72, 77, 0); }
  100% { box-shadow: 0 0 0 0 rgba(229, 72, 77, 0); }
}
`

/** 麦克风内联图标（stroke 风格，跟随 currentColor）。 */
function MicIcon({ size = 14 }: { size?: number }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5.8" y="2.4" width="4.4" height="7.4" rx="2.2" />
      <path d="M4 7.6a4 4 0 0 0 8 0" />
      <path d="M8 11.6v2.2" />
    </svg>
  )
}

/** 设置项按钮的基础样式。 */
const optionButtonBase: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  padding: '7px 10px',
  borderRadius: 10,
  border: '1px solid var(--dsw-alias-border-l1)',
  background: 'var(--dsw-alias-interactive-bg-hover)',
  color: 'var(--dsw-alias-label-secondary)',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 13,
  lineHeight: 1.3,
  textAlign: 'left',
}

/** 设置项按钮选中态样式。 */
const optionButtonSelected: CSSProperties = {
  borderColor: 'var(--dsw-alias-state-business-primary)',
  background: 'var(--dsw-alias-state-business-tertiary)',
  color: 'var(--dsw-alias-label-primary-bluish)',
}

/** 元素是否为可读光标位置的输入框（DSH composer 是 textarea）。 */
function isEditable(el: Element | null): el is HTMLTextAreaElement | HTMLInputElement {
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement
}

/** 在草稿 [start, end) 处替换为 body 的合成文本。 */
function spliceDraft(draft: string, start: number, end: number, body: string): string {
  return draft.slice(0, start) + body + draft.slice(end)
}

/** 识别结束后异步恢复焦点与光标（等 React 完成 setDraft 渲染）。 */
function restoreCaret(el: HTMLElement | null, pos: number): void {
  if (el === null) return
  window.setTimeout(() => {
    if (!el.isConnected) return
    el.focus()
    if (isEditable(el)) {
      try {
        el.setSelectionRange(pos, pos)
      } catch {
        // 忽略（极端场景）。
      }
    }
  }, 0)
}

/** 识别开始时的插入点：焦点输入框的光标位置；无焦点则回退草稿末尾。 */
interface InsertPoint {
  el: HTMLElement | null
  start: number
  end: number
}

function captureInsertPoint(fallback: number): InsertPoint {
  const el = document.activeElement
  if (isEditable(el) && el.selectionStart !== null && el.selectionEnd !== null) {
    return { el, start: el.selectionStart, end: el.selectionEnd }
  }
  return { el: null, start: fallback, end: fallback }
}

export function SpeechInputButton(props: SpeechInputButtonProps): ReactNode {
  const { useInput, inputActions } = props
  const copy = UI_COPY

  // 偏好（localStorage）。
  const [prefs, setPrefs] = useState<SpeechPreferences>(() => loadPreferences())

  // 识别状态。
  const [listening, setListening] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const supported = isSpeechRecognitionSupported()

  // 智谱 API Key（同步读 localStorage 缓存；host 持久化值在挂载时异步拉取）。
  const [zhipuKey, setZhipuKey] = useState<string>(() => loadZhipuApiKeyCached())

  // 实时草稿（组件只读；写入一律走 inputActions）。
  const draft = useInput?.((s) => s.draft) ?? ''
  const draftRef = useRef(draft)
  draftRef.current = draft

  // 识别器与本次识别的基座草稿。
  const recognizerRef = useRef<SpeechRecognizer | null>(null)
  const baseRef = useRef('')
  const finalRef = useRef('')
  const errorTimerRef = useRef<number | undefined>(undefined)
  /** 本次识别的插入点（识别开始时捕捉的光标位置；append 模式使用）。 */
  const insertPointRef = useRef<InsertPoint | null>(null)

  // 该席位只在会话中渲染，理论上 inputActions 恒存在；防御缺失时静默降级。
  if (inputActions === undefined) return null

  /**
   * 把「定稿文本 + 中间文本」写入草稿：replace 整体替换；
   * append 插入到识别开始时的光标位置（无光标信息则追加末尾）。
   */
  const renderDraft = useCallback((finalText: string, interimText: string): void => {
    const body = finalText + interimText
    if (prefs.insertMode === 'replace') {
      inputActions.setDraft(body)
      return
    }
    const point = insertPointRef.current
    const start = point?.start ?? baseRef.current.length
    const end = point?.end ?? start
    // 基准必须用 baseRef.current（识别开始时的草稿快照），而非 draftRef.current
    // （实时草稿）。body = finalText + interimText 已是完整的最新结果，每次
    // onUpdate 都应从原始草稿的固定区间 [start, end) 替换为最新 body；若改用
    // draftRef.current，上一次插入的内容会残留在草稿里，splice（end===start
    // 时只插入不删除）会把新 body 叠在旧 body 之后，累积出「你好你好」式重复。
    const next = spliceDraft(baseRef.current, start, end, body)
    inputActions.setDraft(next)
    if (point?.el !== null && point !== null) restoreCaret(point.el, start + body.length)
  }, [prefs.insertMode, inputActions])

  /**
   * 停止当前识别（如果有）。UI 状态立即复位，但**不**清空
   * recognizerRef：识别器引用要等 onend（onSettled）真正结束才清空。
   * 若在 stop() 之前就清掉引用，用户可立刻启动新一轮识别，而旧识别器
   * 的收尾回调（onend → onSettled → renderDraft）还没执行完，两个
   * 识别器会先后把结果写入草稿，append 模式下出现「你好你好」式重复。
   */
  const stopListening = useCallback((): void => {
    const recognizer = recognizerRef.current
    if (recognizer === null) return
    setListening(false)
    recognizer.stop()
  }, [])

  /** 启动一轮识别。 */
  const startListening = useCallback((): void => {
    if (recognizerRef.current !== null) return
    setError(null)
    setTranscribing(false)
    baseRef.current = draftRef.current
    finalRef.current = ''
    // 捕捉插入点：焦点输入框的光标位置（append 模式在此插入）。
    insertPointRef.current = captureInsertPoint(draftRef.current.length)
    const recognizer = new SpeechRecognizer({
      lang: prefs.lang,
      continuous: prefs.continuous,
      interimResults: prefs.interimFeedback,
      engine: prefs.engine,
      funasrUrl: prefs.funasrUrl,
      funasrModel: prefs.funasrModel,
      funasrAutoStart: prefs.funasrAutoStart,
      funasrStartCommand: prefs.funasrStartCommand,
      funasrStartCwd: prefs.funasrStartCwd,
      funasrIdleMinutes: prefs.funasrIdleMinutes,
    }, {
      onUpdate: (finalText, interimText) => {
        finalRef.current = finalText
        renderDraft(finalText, interimText)
      },
      onSettled: (text) => {
        // 识别收尾（onend：正常停止或自然结束）：复位 UI 状态并落定文本。
        setListening(false)
        setTranscribing(false)
        recognizerRef.current = null
        // replace 模式且无任何识别结果：不覆盖，保留基座草稿。
        if (prefs.insertMode === 'replace' && text === '') {
          inputActions.setDraft(baseRef.current)
          insertPointRef.current = null
          return
        }
        renderDraft(text, '')
        insertPointRef.current = null
      },
      onStatus: (status: SpeechStatus, message?: string) => {
        if (status === 'listening') {
          setListening(true)
          return
        }
        if (status === 'transcribing') {
          setListening(false)
          setTranscribing(true)
          return
        }
        if (status === 'error') {
          setListening(false)
          setTranscribing(false)
          recognizerRef.current = null
          // 出错时收回中间结果：append 保留定稿部分，replace 恢复基座草稿。
          if (prefs.insertMode === 'replace') inputActions.setDraft(baseRef.current)
          else renderDraft(finalRef.current, '')
          setError(message ?? copy.restartHint)
        }
      },
    })
    recognizerRef.current = recognizer
    if (!recognizer.start()) {
      // start() 同步抛错（罕见）：按错误处理。
      recognizerRef.current = null
      setError(copy.restartHint)
    }
  }, [prefs, renderDraft, inputActions, copy.restartHint])

  /** 主按钮点击：切换识别（以识别器引用为权威判断，防 state 不同步卡死）。 */
  const toggleListening = useCallback((): void => {
    if (listening || recognizerRef.current !== null) stopListening()
    else startListening()
  }, [listening, stopListening, startListening])

  /** 错误浮条自动消失。 */
  useEffect(() => {
    if (error === null) return
    errorTimerRef.current = window.setTimeout(() => setError(null), 3800)
    return () => {
      if (errorTimerRef.current !== undefined) window.clearTimeout(errorTimerRef.current)
    }
  }, [error])

  /** 挂载时从 host 拉取持久化的智谱 API Key（覆盖 localStorage 缓存）。 */
  useEffect(() => {
    let cancelled = false
    void loadZhipuApiKey().then((remoteKey) => {
      if (cancelled || remoteKey === '') return
      setZhipuKey(remoteKey)
      saveZhipuApiKey(remoteKey)
    })
    return () => {
      cancelled = true
    }
  }, [])

  /** 组件卸载时中断识别。 */
  useEffect(() => () => {
    recognizerRef.current?.abort()
    recognizerRef.current = null
  }, [])

  /**
   * 长按空格说话（Push-to-Talk）：keydown 空格先拦截默认（空格输入/页面
   * 滚动）并启动长按定时器；300ms 内松开（短按）→ 在光标处补一个空格，
   * 恢复打字语义；超过 300ms（长按）→ 开始识别，松开时停止。细节：
   *  - 输入法组合输入中（isComposing）不拦截，避免干扰中文选字；
   *  - 长按期间的自动重复 keydown（e.repeat）继续阻止默认，光标不乱跑；
   *  - 识别已在运行（如按钮启动）时空格不接管，松开也不会误停；
   *  - 用 ref 转发最新回调，避免 effect 闭包过期。
   */
  const PTT_LONG_PRESS_MS = 300
  const startRef = useRef(startListening)
  startRef.current = startListening
  const stopRef = useRef(stopListening)
  stopRef.current = stopListening
  const pttActiveRef = useRef(false)
  const pttTimerRef = useRef<number | undefined>(undefined)

  /** 在光标处插入文本（短按空格补空格；无输入框焦点则不做）。 */
  const insertAtCaret = useCallback((text: string): void => {
    const el = document.activeElement
    if (!isEditable(el) || el.selectionStart === null || el.selectionEnd === null) return
    const start = el.selectionStart
    const end = el.selectionEnd
    inputActions.setDraft(spliceDraft(draftRef.current, start, end, text))
    restoreCaret(el, start + text.length)
  }, [inputActions])
  const insertAtCaretRef = useRef(insertAtCaret)
  insertAtCaretRef.current = insertAtCaret

  useEffect(() => {
    if (!supported || !prefs.pttEnabled) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || event.isComposing) return
      // 长按期间按住不放的自动重复：继续阻止默认，但不重复启动定时器。
      if (event.repeat) {
        event.preventDefault()
        return
      }
      if (recognizerRef.current !== null) return
      event.preventDefault()
      if (pttTimerRef.current !== undefined) return
      pttTimerRef.current = window.setTimeout(() => {
        pttTimerRef.current = undefined
        pttActiveRef.current = true
        startRef.current()
      }, PTT_LONG_PRESS_MS)
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code !== 'Space') return
      if (pttActiveRef.current) {
        // 长按结束：停止识别。
        pttActiveRef.current = false
        stopRef.current()
        return
      }
      // 短按（定时器未到点）：取消长按，补一个空格恢复打字。
      if (pttTimerRef.current !== undefined) {
        window.clearTimeout(pttTimerRef.current)
        pttTimerRef.current = undefined
        insertAtCaretRef.current(' ')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      if (pttTimerRef.current !== undefined) window.clearTimeout(pttTimerRef.current)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [supported, prefs.pttEnabled])

  /** 保存偏好；若正在识别先收尾（避免模式中途切换）。 */
  const applyPrefs = useCallback((next: SpeechPreferences): void => {
    setPrefs(next)
    savePreferences(next)
    if (listening) stopListening()
  }, [listening, stopListening])

  /** 保存智谱 API Key（输入即存，本地浏览器）。 */
  const applyZhipuKey = useCallback((key: string): void => {
    setZhipuKey(key)
    saveZhipuApiKey(key)
  }, [])

  /** 打开设置对话框时若在识别，先停止。 */
  const openSettings = useCallback((): void => {
    if (listening) stopListening()
    setSettingsOpen(true)
  }, [listening, stopListening])

  const micButtonStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    padding: 0,
    borderRadius: 8,
    border: 'none',
    background: listening ? 'rgba(229, 72, 77, 0.16)' : 'transparent',
    color: listening ? '#e5484d' : 'var(--dsw-alias-label-tertiary)',
    cursor: supported ? 'pointer' : 'not-allowed',
    animation: listening ? 'dsh-speech-input-pulse 1.6s ease-out infinite' : undefined,
    flexShrink: 0,
  }

  /** 状态/错误提示浮条（挂在 28px 宽的按钮容器上）。
   * 坑 1：absolute 元素默认 shrink-to-fit，可用宽度受包含块（28px）限制，
   *       文字会竖着换行 —— 必须显式 width: 'max-content'。
   * 坑 2：主题变量组合不可靠 —— 浅色主题下 label-primary 是深色字，而
   *       surface-raised 可能未定义（回退深色），组成黑底黑字。
   *       浮条是临时提示，直接用固定深底浅字保证对比度。 */
  const badgeStyle: CSSProperties = {
    position: 'absolute',
    right: 0,
    bottom: 'calc(100% + 8px)',
    zIndex: 30,
    width: 'max-content',
    maxWidth: 280,
    padding: '8px 12px',
    borderRadius: 8,
    background: 'rgba(28, 32, 44, 0.96)',
    color: '#f2f4f8',
    border: '1px solid rgba(229, 72, 77, 0.45)',
    borderLeft: '3px solid #e5484d',
    boxShadow: '0 6px 20px rgba(0, 0, 0, 0.35)',
    fontSize: 12.5,
    fontWeight: 500,
    lineHeight: 1.5,
    whiteSpace: 'normal',
    wordBreak: 'break-word',
    pointerEvents: 'none',
  }

  return (
    <>
      <style>{PULSE_KEYFRAMES}</style>
      <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
        {error !== null && (
          <div style={badgeStyle} role="alert">
            {error}
          </div>
        )}

        {error === null && listening && (
          <div style={{ ...badgeStyle, borderColor: 'rgba(229, 72, 77, 0.45)', borderLeftColor: '#e5484d' }} role="status">
            {copy.listeningBadge}
          </div>
        )}

        {error === null && !listening && transcribing && (
          <div style={{ ...badgeStyle, borderColor: 'rgba(255, 255, 255, 0.14)', borderLeftColor: '#8a919e' }} role="status">
            {copy.transcribingBadge}
          </div>
        )}

        <Tooltip label="语音输入设置" side="bottom">
          <button
            type="button"
            aria-label="语音输入设置"
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            onClick={openSettings}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              padding: 0,
              borderRadius: 8,
              border: 'none',
              background: 'transparent',
              color: 'var(--dsw-alias-label-tertiary)',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <IconSettingsOutline14 size={14} />
          </button>
        </Tooltip>

        <Tooltip
          label={supported ? (listening ? copy.tooltipListening : copy.tooltipIdle) : copy.tooltipUnsupported}
          side="bottom"
        >
          <button
            type="button"
            aria-label={supported ? (listening ? copy.tooltipListening : copy.tooltipIdle) : copy.tooltipUnsupported}
            aria-pressed={listening}
            disabled={!supported}
            onClick={toggleListening}
            style={micButtonStyle}
          >
            <MicIcon size={18} />
          </button>
        </Tooltip>
      </div>

      <Modal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title={copy.settingsTitle}
        closeLabel={copy.close}
        description={copy.settingsDescription}
        footer={(
          <Button variant="primary" size="sm" onClick={() => setSettingsOpen(false)}>
            {copy.close}
          </Button>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxHeight: 'min(60vh, 520px)', overflowY: 'auto', paddingRight: 6, overscrollBehavior: 'contain' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{copy.settingsEngine}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {([
                ['funasr', copy.engineFunasr, copy.engineFunasrDesc],
                ['zhipu', copy.engineZhipu, copy.engineZhipuDesc],
              ] as const).map(([engine, label, desc]) => {
                const active = prefs.engine === engine
                return (
                  <button
                    key={engine}
                    type="button"
                    onClick={() => {
                      const next = { ...prefs, engine }
                      applyPrefs(next)
                      if (engine === 'funasr' && next.funasrAutoStart) void ensureFunasrStarted(next)
                    }}
                    style={{
                      ...optionButtonBase,
                      ...(active ? optionButtonSelected : null),
                    }}
                  >
                    <span style={{ fontWeight: 500 }}>{label}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>{desc}</span>
                    {active && <IconCheckOutline16 size={14} />}
                  </button>
                )
              })}
            </div>
          </div>

          {prefs.engine === 'funasr' && (
            <>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{copy.settingsFunasrUrl}</div>
                <input
                  type="text"
                  value={prefs.funasrUrl}
                  placeholder={copy.settingsFunasrUrlPlaceholder}
                  onChange={(event) => applyPrefs({ ...prefs, funasrUrl: event.target.value })}
                  spellCheck={false}
                  autoComplete="off"
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: '1px solid var(--dsw-alias-border-l1)',
                    background: 'var(--dsw-alias-surface-raised)',
                    color: 'var(--dsw-alias-label-primary)',
                    font: 'inherit',
                    fontSize: 13,
                  }}
                />
                <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)', marginTop: 6 }}>
                  {copy.settingsFunasrUrlHint}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{copy.settingsFunasrModel}</div>
                <input
                  type="text"
                  value={prefs.funasrModel}
                  placeholder={copy.settingsFunasrModelPlaceholder}
                  onChange={(event) => applyPrefs({ ...prefs, funasrModel: event.target.value })}
                  spellCheck={false}
                  autoComplete="off"
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: '1px solid var(--dsw-alias-border-l1)',
                    background: 'var(--dsw-alias-surface-raised)',
                    color: 'var(--dsw-alias-label-primary)',
                    font: 'inherit',
                    fontSize: 13,
                  }}
                />
                <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)', marginTop: 6 }}>
                  {copy.settingsFunasrModelHint}
                </div>
              </div>
              <div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={prefs.funasrAutoStart}
                    onChange={(event) => applyPrefs({ ...prefs, funasrAutoStart: event.target.checked })}
                  />
                  {copy.settingsFunasrAutoStart}
                </label>
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{copy.settingsFunasrStartCommand}</div>
                <input
                  type="text"
                  value={prefs.funasrStartCommand}
                  placeholder={copy.settingsFunasrStartCommandPlaceholder}
                  onChange={(event) => applyPrefs({ ...prefs, funasrStartCommand: event.target.value })}
                  spellCheck={false}
                  autoComplete="off"
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: '1px solid var(--dsw-alias-border-l1)',
                    background: 'var(--dsw-alias-surface-raised)',
                    color: 'var(--dsw-alias-label-primary)',
                    font: 'inherit',
                    fontSize: 13,
                  }}
                />
                <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)', marginTop: 6 }}>
                  {copy.settingsFunasrStartCommandHint}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{copy.settingsFunasrStartCwd}</div>
                <input
                  type="text"
                  value={prefs.funasrStartCwd}
                  placeholder={copy.settingsFunasrStartCwdPlaceholder}
                  onChange={(event) => applyPrefs({ ...prefs, funasrStartCwd: event.target.value })}
                  spellCheck={false}
                  autoComplete="off"
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: '1px solid var(--dsw-alias-border-l1)',
                    background: 'var(--dsw-alias-surface-raised)',
                    color: 'var(--dsw-alias-label-primary)',
                    font: 'inherit',
                    fontSize: 13,
                  }}
                />
                <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)', marginTop: 6 }}>
                  {copy.settingsFunasrStartCwdHint}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{copy.settingsFunasrIdleMinutes}</div>
                <select
                  value={String(prefs.funasrIdleMinutes)}
                  onChange={(event) => applyPrefs({ ...prefs, funasrIdleMinutes: Number(event.target.value) })}
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: '1px solid var(--dsw-alias-border-l1)',
                    background: 'var(--dsw-alias-surface-raised)',
                    color: 'var(--dsw-alias-label-primary)',
                    font: 'inherit',
                    fontSize: 13,
                  }}
                >
                  <option value="0">{copy.settingsFunasrIdleNever}</option>
                  <option value="3">{copy.settingsFunasrIdleMinutesOption.replace('{n}', '3')}</option>
                  <option value="5">{copy.settingsFunasrIdleMinutesOption.replace('{n}', '5')}</option>
                  <option value="10">{copy.settingsFunasrIdleMinutesOption.replace('{n}', '10')}</option>
                  <option value="30">{copy.settingsFunasrIdleMinutesOption.replace('{n}', '30')}</option>
                  <option value="60">{copy.settingsFunasrIdleMinutesOption.replace('{n}', '60')}</option>
                </select>
                <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)', marginTop: 6 }}>
                  {copy.settingsFunasrIdleMinutesHint}
                </div>
              </div>
            </>
          )}

          {prefs.engine === 'zhipu' && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{copy.settingsApiKey}</div>
              <input
                type="password"
                value={zhipuKey}
                placeholder={copy.settingsApiKeyPlaceholder}
                onChange={(event) => applyZhipuKey(event.target.value)}
                spellCheck={false}
                autoComplete="off"
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--dsw-alias-border-l1)',
                  background: 'var(--dsw-alias-surface-raised)',
                  color: 'var(--dsw-alias-label-primary)',
                  font: 'inherit',
                  fontSize: 13,
                }}
              />
              <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)', marginTop: 6 }}>
                {copy.settingsApiKeyHint}
              </div>
            </div>
          )}

          <div>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{copy.settingsInsertMode}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {([
                ['append', copy.settingsInsertAppend],
                ['replace', copy.settingsInsertReplace],
              ] as const).map(([mode, label]) => {
                const active = prefs.insertMode === mode
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => applyPrefs({ ...prefs, insertMode: mode })}
                    style={{
                      ...optionButtonBase,
                      ...(active ? optionButtonSelected : null),
                    }}
                  >
                    <span style={{ fontWeight: 500 }}>{label}</span>
                    {active && <IconCheckOutline16 size={14} />}
                  </button>
                )
              })}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label
              style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}
            >
              <input
                type="checkbox"
                checked={prefs.pttEnabled}
                onChange={(event) => applyPrefs({ ...prefs, pttEnabled: event.target.checked })}
              />
              {copy.settingsPtt}
            </label>
          </div>

          <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' }}>
            {copy.restartHint}
          </div>
        </div>
      </Modal>
    </>
  )
}
