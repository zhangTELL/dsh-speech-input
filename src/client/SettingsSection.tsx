/**
 * 「语音输入」应用设置分区（设置窗口左侧导航的 settings.section 席位）。
 *
 * 与 composer 按钮里的设置对话框共享同一份偏好（localStorage
 * dsh.speechInput.v1）和智谱 Key 持久化（host 路由 + localStorage 缓存），
 * 两处入口改任一处都同步生效。本页面只做静态表单，不含识别逻辑。
 *
 * 注册契约（0.1.2-rc.1，与 dsh-plugin-desktop 的桌面设置页同形）：
 * `settings.section` 是 list 槽，第二参为 React 组件，宿主负责渲染；
 * label 提供导航标题。注意 list 槽组件由宿主按条目渲染，不要传入
 * vanilla {render} 对象（宿主不识别，页面会空白）。
 */
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { IconCheckOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { UI_COPY, loadPreferences, savePreferences, type SpeechPreferences } from './settings.ts'
import { ensureFunasrStarted, loadZhipuApiKey, loadZhipuApiKeyCached, saveZhipuApiKey } from './speech.ts'

/**
 * 本插件对插槽合同的类型声明：宿主 GUI 在运行时声明了 `settings.section`
 * （list，导航分区），这里按桌面设置页（dsh-plugin-desktop）的同形注册面
 * 声明，以便 register 做编译期校验。
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'settings.section': {
      kind: 'list'
      owner: unknown
    }
  }
}

/** 组件接收的 props 子集（宿主还会注入标准套件，这里只声明用到的）。 */
interface SpeechInputSettingsSectionProps {
  t?: (key: string) => string
}

/** 设置项按钮的基础样式（与 composer 设置对话框同款）。 */
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

const fieldTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 8,
}

const hintStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.6,
  color: 'var(--dsw-alias-label-tertiary)',
  marginTop: 6,
}

/**
 * 语音输入设置分区页面。
 *
 * Key 输入即存（与对话框一致）；插入模式与长按空格开关点击即生效。
 */
export function SpeechInputSettingsSection(_props: SpeechInputSettingsSectionProps): ReactNode {
  const copy = UI_COPY
  const [prefs, setPrefs] = useState(() => loadPreferences())
  const [zhipuKey, setZhipuKey] = useState(() => loadZhipuApiKeyCached())

  /** 挂载时从 host 拉取持久化的智谱 API Key（覆盖 localStorage 缓存）。 */
  useEffect(() => {
    let cancelled = false
    loadZhipuApiKey().then((remoteKey) => {
      if (cancelled || remoteKey === '') return
      setZhipuKey(remoteKey)
      saveZhipuApiKey(remoteKey)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const applyPrefs = useCallback((next: SpeechPreferences) => {
    setPrefs(next)
    savePreferences(next)
  }, [])

  const applyZhipuKey = useCallback((key: string) => {
    setZhipuKey(key)
    saveZhipuApiKey(key)
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560, maxHeight: 'min(60vh, 520px)', overflowY: 'auto', paddingRight: 8, overscrollBehavior: 'contain' }}>
      <div>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0, marginBottom: 6 }}>{copy.settingsTitle}</h2>
        <div style={hintStyle}>{copy.settingsDescription}</div>
      </div>
      <div>
        <div style={fieldTitleStyle}>{copy.settingsEngine}</div>
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
                style={{ ...optionButtonBase, ...(active ? optionButtonSelected : null) }}
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
            <div style={fieldTitleStyle}>{copy.settingsFunasrUrl}</div>
            <input
              type="text"
              value={prefs.funasrUrl}
              placeholder={copy.settingsFunasrUrlPlaceholder}
              onChange={(event) => applyPrefs({ ...prefs, funasrUrl: event.target.value })}
              spellCheck={false}
              autoComplete="off"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '8px 10px',
                borderRadius: 8,
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'var(--dsw-alias-surface-raised)',
                color: 'var(--dsw-alias-label-primary)',
                font: 'inherit',
                fontSize: 13,
              }}
            />
            <div style={hintStyle}>{copy.settingsFunasrUrlHint}</div>
          </div>
          <div>
            <div style={fieldTitleStyle}>{copy.settingsFunasrModel}</div>
            <input
              type="text"
              value={prefs.funasrModel}
              placeholder={copy.settingsFunasrModelPlaceholder}
              onChange={(event) => applyPrefs({ ...prefs, funasrModel: event.target.value })}
              spellCheck={false}
              autoComplete="off"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '8px 10px',
                borderRadius: 8,
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'var(--dsw-alias-surface-raised)',
                color: 'var(--dsw-alias-label-primary)',
                font: 'inherit',
                fontSize: 13,
              }}
            />
            <div style={hintStyle}>{copy.settingsFunasrModelHint}</div>
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
            <div style={fieldTitleStyle}>{copy.settingsFunasrStartCommand}</div>
            <input
              type="text"
              value={prefs.funasrStartCommand}
              placeholder={copy.settingsFunasrStartCommandPlaceholder}
              onChange={(event) => applyPrefs({ ...prefs, funasrStartCommand: event.target.value })}
              spellCheck={false}
              autoComplete="off"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '8px 10px',
                borderRadius: 8,
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'var(--dsw-alias-surface-raised)',
                color: 'var(--dsw-alias-label-primary)',
                font: 'inherit',
                fontSize: 13,
              }}
            />
            <div style={hintStyle}>{copy.settingsFunasrStartCommandHint}</div>
          </div>
          <div>
            <div style={fieldTitleStyle}>{copy.settingsFunasrStartCwd}</div>
            <input
              type="text"
              value={prefs.funasrStartCwd}
              placeholder={copy.settingsFunasrStartCwdPlaceholder}
              onChange={(event) => applyPrefs({ ...prefs, funasrStartCwd: event.target.value })}
              spellCheck={false}
              autoComplete="off"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '8px 10px',
                borderRadius: 8,
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'var(--dsw-alias-surface-raised)',
                color: 'var(--dsw-alias-label-primary)',
                font: 'inherit',
                fontSize: 13,
              }}
            />
            <div style={hintStyle}>{copy.settingsFunasrStartCwdHint}</div>
          </div>
          <div>
            <div style={fieldTitleStyle}>{copy.settingsFunasrIdleMinutes}</div>
            <select
              value={String(prefs.funasrIdleMinutes)}
              onChange={(event) => applyPrefs({ ...prefs, funasrIdleMinutes: Number(event.target.value) })}
              style={{
                width: '100%',
                boxSizing: 'border-box',
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
            <div style={hintStyle}>{copy.settingsFunasrIdleMinutesHint}</div>
          </div>
        </>
      )}

      {prefs.engine === 'zhipu' && (
        <div>
          <div style={fieldTitleStyle}>{copy.settingsApiKey}</div>
          <input
            type="password"
            value={zhipuKey}
            placeholder={copy.settingsApiKeyPlaceholder}
            onChange={(event) => applyZhipuKey(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '8px 10px',
              borderRadius: 8,
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-surface-raised)',
              color: 'var(--dsw-alias-label-primary)',
              font: 'inherit',
              fontSize: 13,
            }}
          />
          <div style={hintStyle}>{copy.settingsApiKeyHint}</div>
        </div>
      )}

      <div>
        <div style={fieldTitleStyle}>{copy.settingsInsertMode}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {([['append', copy.settingsInsertAppend], ['replace', copy.settingsInsertReplace]] as const).map(([mode, label]) => {
            const active = prefs.insertMode === mode
            return (
              <button
                key={mode}
                type="button"
                onClick={() => applyPrefs({ ...prefs, insertMode: mode })}
                style={{ ...optionButtonBase, ...(active ? optionButtonSelected : null) }}
              >
                <span style={{ fontWeight: 500 }}>{label}</span>
                {active && <IconCheckOutline16 size={14} />}
              </button>
            )
          })}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={prefs.pttEnabled}
            onChange={(event) => applyPrefs({ ...prefs, pttEnabled: event.target.checked })}
          />
          {copy.settingsPtt}
        </label>
      </div>
      <div style={hintStyle}>{copy.restartHint}</div>
    </div>
  )
}
