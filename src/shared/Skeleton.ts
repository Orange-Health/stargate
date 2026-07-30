import { createElement } from 'react'

type Props = {
  className?: string
}

export function Skeleton({ className = '' }: Props) {
  return createElement('span', {
    'aria-hidden': true,
    className: `skeleton ${className}`.trim(),
  })
}
