import {
  useEffect,
  useRef,
  type MouseEventHandler,
  type ReactNode,
} from 'react'

let openModalCount = 0
const modalRoots: HTMLElement[] = []

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

function lockPageScroll() {
  if (openModalCount === 0) {
    document.documentElement.dataset.modalOpen = 'true'
    document.body.dataset.modalOpen = 'true'
  }
  openModalCount += 1
}

function unlockPageScroll() {
  openModalCount = Math.max(0, openModalCount - 1)
  if (openModalCount === 0) {
    delete document.documentElement.dataset.modalOpen
    delete document.body.dataset.modalOpen
  }
}

function canScroll(element: HTMLElement) {
  const style = window.getComputedStyle(element)
  const overflowY = style.overflowY
  const scrollable =
    overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay'
  return scrollable && element.scrollHeight > element.clientHeight
}

function isScrollableDialogTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false
  const dialog = target.closest('.release-dialog')
  if (!(dialog instanceof HTMLElement)) return false

  let node: Element | null = target
  while (node && dialog.contains(node)) {
    if (node instanceof HTMLElement && canScroll(node)) return true
    if (node === dialog) break
    node = node.parentElement
  }
  return canScroll(dialog)
}

function isFocusable(element: HTMLElement) {
  if (element.closest('[inert], [aria-hidden="true"]')) return false
  if (element.getClientRects().length === 0) return false
  return true
}

function getFocusableElements(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(isFocusable)
}

function isTopModal(root: HTMLElement) {
  return modalRoots[modalRoots.length - 1] === root
}

export function DialogBackdrop({
  children,
  onMouseDown,
  className,
}: {
  children: ReactNode
  onMouseDown?: MouseEventHandler<HTMLDivElement>
  className?: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    lockPageScroll()
    modalRoots.push(root)

    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null

    const dialog = root.querySelector<HTMLElement>('.release-dialog')
    if (dialog && !dialog.hasAttribute('tabindex')) {
      dialog.tabIndex = -1
    }

    const focusables = getFocusableElements(root)
    const initialFocus = focusables[0] ?? dialog
    initialFocus?.focus()

    const preventBackgroundScroll = (event: WheelEvent | TouchEvent) => {
      if (!isTopModal(root)) return
      if (isScrollableDialogTarget(event.target)) return
      event.preventDefault()
    }

    const trapTab = (event: KeyboardEvent) => {
      if (!isTopModal(root) || event.key !== 'Tab') return

      const elements = getFocusableElements(root)
      if (elements.length === 0) {
        event.preventDefault()
        dialog?.focus()
        return
      }

      const first = elements[0]
      const last = elements[elements.length - 1]
      const active = document.activeElement

      if (event.shiftKey) {
        if (active === first || !root.contains(active)) {
          event.preventDefault()
          last.focus()
        }
        return
      }

      if (active === last || !root.contains(active)) {
        event.preventDefault()
        first.focus()
      }
    }

    const keepFocusInside = (event: FocusEvent) => {
      if (!isTopModal(root)) return
      if (event.target instanceof Node && root.contains(event.target)) return

      const elements = getFocusableElements(root)
      ;(elements[0] ?? dialog)?.focus()
    }

    document.addEventListener('wheel', preventBackgroundScroll, {
      passive: false,
    })
    document.addEventListener('touchmove', preventBackgroundScroll, {
      passive: false,
    })
    document.addEventListener('keydown', trapTab)
    document.addEventListener('focusin', keepFocusInside)

    return () => {
      document.removeEventListener('wheel', preventBackgroundScroll)
      document.removeEventListener('touchmove', preventBackgroundScroll)
      document.removeEventListener('keydown', trapTab)
      document.removeEventListener('focusin', keepFocusInside)

      const index = modalRoots.lastIndexOf(root)
      if (index >= 0) modalRoots.splice(index, 1)

      unlockPageScroll()

      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus()
      }
    }
  }, [])

  return (
    <div
      ref={rootRef}
      className={['dialog-backdrop', className].filter(Boolean).join(' ')}
      role="presentation"
      onMouseDown={onMouseDown}
    >
      {children}
    </div>
  )
}
