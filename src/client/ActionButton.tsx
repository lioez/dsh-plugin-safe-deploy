import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  DEPLOY_PROMPT,
  PUBLISH_CHECK_PROMPT,
  REFUSE_TITLE,
  composerControlReason,
  planComposerSubmit,
  runComposerSubmit,
  type ComposerActions,
  type ComposerInputSnapshot,
} from './composer-submit.ts'

export interface ComposerActionButtonProps {
  sessionId?: string
  useInput?: (select: (state: ComposerInputSnapshot) => ComposerInputSnapshot) => ComposerInputSnapshot | undefined
  inputActions?: ComposerActions
  useSession?: (select: (state: { removed?: boolean }) => unknown) => unknown
}

const MENU_WIDTH = 190
const MENU_ESTIMATED_HEIGHT = 112

const rootStyle = {
  position: 'relative',
} as const

const triggerStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 3,
  minHeight: 28,
  padding: '3px 4px',
  border: 0,
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 12,
  lineHeight: '18px',
  cursor: 'pointer',
} as const

const triggerDisabledStyle = {
  ...triggerStyle,
  cursor: 'default',
  opacity: 0.45,
} as const

/**
 * The menu is rendered in a portal because the session-header action row is a
 * clipped/stacking-context container in the Web UI. Keeping the menu inside
 * that row made it render but stay invisible (overflow/z-index). A body portal
 * with fixed coordinates is independent of the header's clipping.
 */
const menuStyle = {
  position: 'fixed',
  zIndex: 2147483000,
  boxSizing: 'border-box',
  minWidth: 168,
  maxWidth: 'calc(100vw - 16px)',
  margin: 0,
  padding: 4,
  listStyle: 'none',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 12,
  background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-layer-3)))',
  boxShadow: 'var(--dsw-shadow-lv3)',
} as const

const itemStyle = {
  display: 'block',
  width: '100%',
  boxSizing: 'border-box',
  textAlign: 'left',
  minHeight: 32,
  padding: '6px 8px',
  border: 0,
  borderRadius: 8,
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 13,
  lineHeight: '18px',
  cursor: 'pointer',
} as const

interface MenuPosition {
  top: number
  left: number
}

function snapshotFromKit(props: ComposerActionButtonProps): ComposerInputSnapshot | undefined {
  if (typeof props.useInput !== 'function') return undefined
  const state = props.useInput(current => current)
  if (state === undefined) return undefined
  const removed = typeof props.useSession === 'function'
    && props.useSession(session => session.removed) === true
  return {
    draft: state.draft,
    phase: state.phase,
    sessionRemoved: removed,
  }
}

export function ComposerActionButton(props: ComposerActionButtonProps) {
  const [open, setOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLUListElement | null>(null)

  const calculatePosition = (): MenuPosition => {
    const trigger = triggerRef.current
    if (trigger === null) return { top: 8, left: 8 }
    const rect = trigger.getBoundingClientRect()
    const viewportWidth = typeof window !== 'undefined' && typeof window.innerWidth === 'number'
      ? window.innerWidth
      : 1024
    const viewportHeight = typeof window !== 'undefined' && typeof window.innerHeight === 'number'
      ? window.innerHeight
      : 768
    const maxLeft = Math.max(8, viewportWidth - MENU_WIDTH - 8)
    const left = Math.min(Math.max(8, rect.left), maxLeft)
    const below = rect.bottom + 6
    const top = below + MENU_ESTIMATED_HEIGHT <= viewportHeight
      ? below
      : Math.max(8, rect.top - MENU_ESTIMATED_HEIGHT - 6)
    return { top, left }
  }

  useEffect(() => {
    if (!open) return
    const update = () => { setMenuPosition(calculatePosition()) }
    update()
    const closeOutside = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (rootRef.current?.contains(target) === true || menuRef.current?.contains(target) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  const hasSession = props.sessionId !== undefined
    && typeof props.useInput === 'function'
    && props.inputActions !== undefined
  const input = snapshotFromKit(props)
  const actions = props.inputActions
  const blocked = composerControlReason(input, actions)

  if (!hasSession || input?.sessionRemoved === true) return null

  const title = blocked === undefined ? '写入一句部署/校验指令并提交，走正常 agent turn' : REFUSE_TITLE[blocked]
  const disabled = blocked !== undefined

  const pick = (prompt: string) => {
    setOpen(false)
    runComposerSubmit(prompt, input, actions)
  }

  const toggleOpen = () => {
    if (disabled) return
    if (open) {
      setOpen(false)
      return
    }
    setMenuPosition(calculatePosition())
    setOpen(true)
  }

  const menu = open && menuPosition !== null && typeof document !== 'undefined'
    ? createPortal(
        <ul
          ref={menuRef}
          role="menu"
          aria-label="部署或检查发布"
          style={{ ...menuStyle, top: menuPosition.top, left: menuPosition.left }}
        >
          <li>
            <button
              type="button"
              role="menuitem"
              style={itemStyle}
              disabled={planComposerSubmit(DEPLOY_PROMPT, input, actions).action !== 'submit'}
              onClick={() => { pick(DEPLOY_PROMPT) }}
            >
              部署到 Cloudflare
            </button>
          </li>
          <li>
            <button
              type="button"
              role="menuitem"
              style={itemStyle}
              disabled={planComposerSubmit(PUBLISH_CHECK_PROMPT, input, actions).action !== 'submit'}
              onClick={() => { pick(PUBLISH_CHECK_PROMPT) }}
            >
              检查插件发布
            </button>
          </li>
        </ul>,
        document.body,
      )
    : null

  return (
    <div ref={rootRef} style={rootStyle}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="部署或检查发布"
        title={title}
        disabled={disabled}
        style={disabled ? triggerDisabledStyle : triggerStyle}
        onClick={toggleOpen}
      >
        发布
        <span aria-hidden="true" style={{ fontSize: 10, lineHeight: '18px', opacity: 0.7 }}>
          {open ? '▴' : '▾'}
        </span>
      </button>
      {menu}
    </div>
  )
}

export interface ComposerRetryButtonProps {
  prompt: string
  label: string
  useInput: (select: (state: ComposerInputSnapshot) => ComposerInputSnapshot) => ComposerInputSnapshot
  inputActions: ComposerActions
}

export function ComposerRetryButton(props: ComposerRetryButtonProps) {
  const input = props.useInput(state => state)
  const plan = planComposerSubmit(props.prompt, input, props.inputActions)
  const disabled = plan.action !== 'submit'
  return (
    <button
      type="button"
      disabled={disabled}
      title={disabled && plan.action === 'refuse' ? REFUSE_TITLE[plan.reason] : undefined}
      onClick={() => {
        runComposerSubmit(props.prompt, input, props.inputActions)
      }}
    >
      {props.label}
    </button>
  )
}

export function maybeComposerRetry(
  props: {
    useInput?: ComposerRetryButtonProps['useInput']
    inputActions?: ComposerActions
  },
  prompt: string,
  label: string,
) {
  if (props.inputActions === undefined || typeof props.useInput !== 'function') return null
  return (
    <ComposerRetryButton
      prompt={prompt}
      label={label}
      useInput={props.useInput}
      inputActions={props.inputActions}
    />
  )
}
