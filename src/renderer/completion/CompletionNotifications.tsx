import { useCallback, useEffect, useRef, useState } from 'react'
import {
  COMPLETION_NOTIFICATION,
  COMPLETION_NOTIFICATION_IPC,
  type CompletionNotification,
} from '@shared/completion-notification'
import './CompletionNotifications.css'

type LeavingMode = 'dismissed' | 'activated'

function CompletionCard({
  notification,
  onActivate,
  onDismiss,
}: {
  notification: CompletionNotification
  onActivate: (notification: CompletionNotification) => void
  onDismiss: (id: string) => void
}) {
  const [leaving, setLeaving] = useState<LeavingMode | null>(null)
  const exitTimerRef = useRef<number | null>(null)
  const leavingRef = useRef(false)

  const finish = useCallback((mode: LeavingMode) => {
    if (leavingRef.current) return
    leavingRef.current = true
    setLeaving(mode)
    if (mode === 'activated') onActivate(notification)
    const duration = mode === 'activated' ? 230 : 190
    exitTimerRef.current = window.setTimeout(() => {
      void window.api.invoke(COMPLETION_NOTIFICATION_IPC.IGNORE_MOUSE, true)
      onDismiss(notification.id)
    }, duration)
  }, [notification, onActivate, onDismiss])

  useEffect(() => {
    return () => {
      if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current)
    }
  }, [])

  return (
    <div
      className={`completion-notification-card${leaving ? ` is-${leaving}` : ''}`}
      role="group"
      aria-label={`${notification.sessionName} 工作结束通知`}
      onMouseEnter={() => {
        void window.api.invoke(COMPLETION_NOTIFICATION_IPC.IGNORE_MOUSE, false)
      }}
      onMouseLeave={() => {
        void window.api.invoke(COMPLETION_NOTIFICATION_IPC.IGNORE_MOUSE, true)
      }}
    >
      <button
        type="button"
        className="completion-notification-target"
        aria-label={`切换到 ${notification.sessionName}`}
        onClick={() => finish('activated')}
      >
        <span className="completion-notification-name">{notification.sessionName}</span>
      </button>
      <button
        type="button"
        className="completion-notification-ignore"
        aria-label={`忽略 ${notification.sessionName} 的完成通知`}
        onClick={(event) => {
          event.stopPropagation()
          finish('dismissed')
        }}
      >
        ×
      </button>
    </div>
  )
}

export default function CompletionNotifications() {
  const [notifications, setNotifications] = useState<CompletionNotification[]>([])

  useEffect(() => {
    document.body.className = 'completion-notification-mode'
    const unsubscribe = window.api.on(
      COMPLETION_NOTIFICATION_IPC.CHANGED,
      (next: unknown) => setNotifications(Array.isArray(next) ? next as CompletionNotification[] : []),
    )
    void window.api.invoke(COMPLETION_NOTIFICATION_IPC.LIST).then((next) => {
      setNotifications(Array.isArray(next) ? next as CompletionNotification[] : [])
    })
    return unsubscribe
  }, [])

  const dismiss = useCallback((id: string) => {
    // Reflow the visible stack without waiting for Electron's main process.
    // Session activation may be doing tmux work, but that must not pin an
    // already-finished exit animation in the middle of the stack.
    setNotifications((current) => current.filter((notification) => notification.id !== id))
    void window.api.invoke(COMPLETION_NOTIFICATION_IPC.DISMISS, id)
  }, [])

  const activate = useCallback((notification: CompletionNotification) => {
    void window.api.invoke('session:attach', notification.sessionId).catch((error) => {
      console.error('[completion-notification] attach failed:', error)
    })
  }, [])

  return (
    <main
      className="completion-notification-stack"
      aria-live="polite"
      aria-label="会话完成通知"
    >
      {notifications.slice(0, COMPLETION_NOTIFICATION.MAX_VISIBLE).map((notification) => (
        <CompletionCard
          key={notification.id}
          notification={notification}
          onActivate={activate}
          onDismiss={dismiss}
        />
      ))}
    </main>
  )
}
