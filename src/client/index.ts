/**
 * dsh-speech-input 浏览器侧（Client half）。
 *
 * 把「语音输入」按钮组注册到会话输入框右下角的 `conversation.input.right`
 * 席位（list 席位，多个条目并列；与 dsh-language-input 的语言按钮并排）。
 *
 * 关键（0.1.2-rc.1 slots 契约）：直接 `inject('conversation.input.right')`
 * 等待该子槽被声明（由 conversation.composer.bar 的 children 表声明），
 * 而不是注入父槽 'conversation'——父槽先声明、子槽后声明，若在父槽回调里
 * 立刻 register 子槽会被 SlotCore 以 "slot is not declared" 拒绝（桌面端
 * 自己的 shell.overlay 也是直接 inject 子槽名，见 dsh-plugin-desktop client）。
 * 子槽的 SlotMap 类型声明见 SpeechInputButton.tsx。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { SpeechInputButton } from './SpeechInputButton.tsx'
import { SpeechInputSettingsSection } from './SettingsSection.tsx'

/** 依赖的运行时服务：slots 注册面。 */
export const inject = ['slots']

/** 设置导航行标记（供 CSS 把 fallback 齿轮换成麦克风图标）。 */
const NAV_MARKER = 'data-dsh-speech-input-settings-nav'

/**
 * 给设置导航里本插件的行打标记（同 dsh-better-sidebar 的做法：宿主 0.1.x
 * 从 settings.section 注册只投影 id/order/label，图标由 shell 按内置 id 硬编码，
 * 席位无图标字段，只能在对话框挂载后按 label 文本定位自己的行）。
 * @returns 清理函数（移除本插件拥有的标记）。
 */
function registerSettingsNavMarker(): () => void {
  const sync = (): void => {
    const buttons = document.querySelectorAll<HTMLButtonElement>('[role="dialog"] nav button')
    for (const button of buttons) {
      if (button.textContent?.trim() === '语音输入') button.setAttribute(NAV_MARKER, '')
      else button.removeAttribute(NAV_MARKER)
    }
  }
  sync()
  const observer = new MutationObserver(sync)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  return () => {
    observer.disconnect()
    document.querySelectorAll(`[${NAV_MARKER}]`).forEach((el) => el.removeAttribute(NAV_MARKER))
  }
}

/** 导航图标替换样式：隐藏 fallback 齿轮，用麦克风 glyph（跟随 currentColor）。 */
const NAV_ICON_CSS = `
[data-dsh-speech-input-settings-nav] > svg:first-child { display: none; }
[data-dsh-speech-input-settings-nav]::before {
  content: ''; flex: none; width: 16px; height: 16px; background: currentColor;
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='9' y='2' width='6' height='12' rx='3'/%3E%3Cpath d='M5 10a7 7 0 0 0 14 0'/%3E%3Cpath d='M12 19v3'/%3E%3C/svg%3E") no-repeat center / contain;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='9' y='2' width='6' height='12' rx='3'/%3E%3Cpath d='M5 10a7 7 0 0 0 14 0'/%3E%3Cpath d='M12 19v3'/%3E%3C/svg%3E") no-repeat center / contain;
}
`

/**
 * 挂载语音输入按钮组。
 * @param ctx - 浏览器端根上下文。
 */
export function apply(ctx: ClientContext): void {
  const style = document.createElement('style')
  style.id = 'dsh-speech-input-nav-icon'
  style.textContent = NAV_ICON_CSS
  document.head.appendChild(style)
  registerSettingsNavMarker()

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'speech-input',
    order: 210,
  }, SpeechInputButton))

  // 应用设置窗口的「语音输入」分区（与 composer 设置对话框共享同一份偏好）。
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'speech-input',
    order: 50,
    label: () => '语音输入',
  }, SpeechInputSettingsSection))
}
