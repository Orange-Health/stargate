import type { PullRequest } from './types.js'

export function isClosedWithoutMerge(
  pullRequest?: Pick<PullRequest, 'state' | 'merged'>,
) {
  return pullRequest?.state === 'closed' && !pullRequest.merged
}
