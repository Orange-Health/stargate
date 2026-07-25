import type {
  ReleaseDashboard,
  ReleaseItem,
  TrackedProductionRelease,
} from '../../shared/types'

export const RELEASE_NOTES_BOT_AUTHORS = ['devopsautomation-oh'] as const

export type ReleaseNotesFormat = 'slack' | 'plain'

export type ReleaseNoteChange = {
  issueKey?: string
  issueUrl?: string
  title: string
  author?: string
  url?: string
}

export function releaseCreatedOnDate(
  createdAt: string,
  releaseDate: string,
) {
  return /^\d{4}-\d{2}-\d{2}$/.test(releaseDate)
    ? createdAt.slice(0, 10) === releaseDate
    : false
}

export function latestProductionReleaseOnDate(
  releases: TrackedProductionRelease[],
  releaseDate: string,
) {
  return releases
    .filter((release) => releaseCreatedOnDate(release.createdAt, releaseDate))
    .sort(
      (left, right) =>
        new Date(right.createdAt).getTime() -
        new Date(left.createdAt).getTime(),
    )[0]
}

// ponytail: title heuristics cover the internal promotion/back-merge noise we see today; widen the list when new cut patterns show up.
const INTERNAL_RELEASE_NOTE_TITLE_PATTERNS = [
  /^dev cut:\s*dev\s*->\s*release\b/i,
  /^back-?merge main into release\b/i,
  /^back-?merge release into dev\b/i,
  /^release by\b/i,
  /^dev by\b/i,
  /^dev\s*->\s*release\b/i,
] as const

export function isReleaseNotesBotAuthor(value: string) {
  const login = value.replace(/^@/, '').toLowerCase()
  return (RELEASE_NOTES_BOT_AUTHORS as readonly string[]).includes(login)
}

export function isInternalReleaseNoteTitle(title: string) {
  return INTERNAL_RELEASE_NOTE_TITLE_PATTERNS.some((pattern) =>
    pattern.test(title.trim()),
  )
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function stripTrailingUrlJunk(url: string) {
  return url.replace(/[).,]+$/g, '')
}

function shouldDropReleaseNoteLine(line: string) {
  const trimmed = line.trim()
  if (!trimmed) return false
  if (/^#{0,6}\s*New Contributors\s*$/i.test(trimmed)) return true
  if (/^\*{0,2}Full Changelog\*{0,2}\s*:/i.test(trimmed)) return true
  if (/made their first contribution/i.test(trimmed)) return true

  const authors = [...trimmed.matchAll(/@([A-Za-z0-9-]+)/g)].map(
    (match) => match[1],
  )
  if (authors.some((author) => isReleaseNotesBotAuthor(author))) return true
  if (
    /back(?:port|merg)/i.test(trimmed) &&
    /devopsautomation-oh/i.test(trimmed)
  ) {
    return true
  }

  const bullet = /^\s*[-*•]\s+(.+)$/.exec(trimmed)
  if (bullet && isInternalReleaseNoteTitle(bullet[1])) return true

  return false
}

export function cleanGitHubReleaseDescription(text: string) {
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, '').trim()
  if (!withoutComments) return ''

  const keptLines: string[] = []
  for (const line of withoutComments.split('\n')) {
    if (shouldDropReleaseNoteLine(line)) continue
    keptLines.push(line)
  }

  return keptLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function markdownInlineToHtml(text: string) {
  return escapeHtml(text)
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
      '<a href="$2">$1</a>',
    )
    .replace(
      /(https?:\/\/github\.com\/[^\s<]+)/g,
      '<a href="$1">$1</a>',
    )
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_]+)__/g, '<b>$1</b>')
}

export function githubDescriptionToHtml(text: string) {
  const cleaned = cleanGitHubReleaseDescription(text)
  if (!cleaned) return ''

  const blocks: string[] = []
  let listItems: string[] = []

  const flushList = () => {
    if (listItems.length === 0) return
    blocks.push(`<ul>${listItems.join('')}</ul>`)
    listItems = []
  }

  for (const line of cleaned.split('\n')) {
    const heading = /^#{1,6}\s+(.+)$/.exec(line)
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line)
    if (heading) {
      flushList()
      blocks.push(`<p><b>${markdownInlineToHtml(heading[1])}</b></p>`)
      continue
    }
    if (bullet) {
      listItems.push(`<li>${markdownInlineToHtml(bullet[1])}</li>`)
      continue
    }
    if (!line.trim()) {
      flushList()
      continue
    }
    flushList()
    blocks.push(`<p>${markdownInlineToHtml(line)}</p>`)
  }
  flushList()
  return blocks.join('')
}

export function githubDescriptionToPlain(text: string) {
  return cleanGitHubReleaseDescription(text)
    .replace(/^#{1,6}\s+(.+)$/gm, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 ($2)')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function parseMarkdownLink(value: string) {
  const markdown = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/.exec(value)
  if (markdown) return stripTrailingUrlJunk(markdown[2])
  if (/^https?:\/\//.test(value)) return stripTrailingUrlJunk(value)
  return undefined
}

export function parseReleaseNoteChangeLine(
  line: string,
): ReleaseNoteChange | null {
  const bullet = /^\s*[-*•]\s+(.+)$/.exec(line.trim())
  if (!bullet) return null
  const body = bullet[1].trim()
  if (isInternalReleaseNoteTitle(body)) return null
  if (/made their first contribution/i.test(body)) return null

  const withAuthorAndUrl =
    /^(.+?)\s+by\s+@([A-Za-z0-9-]+)\s+in\s+(\S+)$/i.exec(body)
  if (withAuthorAndUrl) {
    const title = withAuthorAndUrl[1].trim()
    const author = withAuthorAndUrl[2]
    const url = parseMarkdownLink(withAuthorAndUrl[3])
    if (!title || isReleaseNotesBotAuthor(author)) return null
    return { title, author, url }
  }

  return { title: body }
}

export function extractReleaseNoteChanges(text: string): ReleaseNoteChange[] {
  const cleaned = cleanGitHubReleaseDescription(text)
  if (!cleaned) return []

  const changes: ReleaseNoteChange[] = []
  for (const line of cleaned.split('\n')) {
    const change = parseReleaseNoteChangeLine(line)
    if (change) changes.push(change)
  }
  return changes
}

function githubProfileUrl(login: string) {
  return `https://github.com/${login.replace(/^@/, '')}`
}

function formatSlackAuthor(author: string | undefined) {
  if (!author) return ''
  const login = author.replace(/^@/, '')
  return ` by <${githubProfileUrl(login)}|@${login}>`
}

function formatPlainAuthor(author: string | undefined) {
  if (!author) return ''
  const login = author.replace(/^@/, '')
  return ` by @${login} (${githubProfileUrl(login)})`
}

function formatHtmlAuthor(author: string | undefined) {
  if (!author) return ''
  const login = author.replace(/^@/, '')
  return ` by <a href="${escapeHtml(githubProfileUrl(login))}">@${escapeHtml(login)}</a>`
}

function formatSlackChange(change: ReleaseNoteChange) {
  const label =
    change.issueKey && change.issueUrl
      ? `<${change.issueUrl}|${change.issueKey}>: ${change.title}`
      : change.issueKey
        ? `${change.issueKey}: ${change.title}`
        : change.title
  const author = formatSlackAuthor(change.author)
  if (change.url) {
    return `- ${label}${author} in <${change.url}|PR>`
  }
  return `- ${label}${author}`
}

function formatPlainChange(change: ReleaseNoteChange) {
  const label = change.issueKey
    ? `${change.issueKey}: ${change.title}`
    : change.title
  const author = formatPlainAuthor(change.author)
  if (change.url) {
    return `• ${label}${author} in ${change.url}`
  }
  if (change.issueUrl) {
    return `• ${label}${author}\n  ${change.issueUrl}`
  }
  return `• ${label}${author}`
}

export function shouldIncludeReleaseItem(item: ReleaseItem) {
  const author = item.pullRequest?.author
  if (author && isReleaseNotesBotAuthor(author)) return false
  if (isInternalReleaseNoteTitle(item.issue.summary)) return false
  if (
    item.pullRequest?.title &&
    isInternalReleaseNoteTitle(item.pullRequest.title)
  ) {
    return false
  }
  return true
}

export function serviceChangeItems(
  service: ReleaseDashboard['services'][number],
): ReleaseNoteChange[] {
  return service.items.filter(shouldIncludeReleaseItem).map((item) => ({
    issueKey: item.issue.key,
    issueUrl: item.issue.url,
    title: item.issue.summary,
    author: item.pullRequest?.author,
    url: item.pullRequest?.url,
  }))
}

function serviceNameFromRepository(repository: string) {
  return repository.split('/').at(-1) ?? repository
}

export function releaseNotesForDashboard(
  dashboard: ReleaseDashboard,
  releasesByRepository: Record<string, TrackedProductionRelease[]>,
  releaseDate: string,
) {
  const plainSections: string[] = []
  const slackSections: string[] = []
  const htmlSections: string[] = []

  for (const service of dashboard.services) {
    const release = latestProductionReleaseOnDate(
      releasesByRepository[service.repository] ?? [],
      releaseDate,
    )
    const serviceName = serviceNameFromRepository(service.repository)
    // Jira tickets are the source of truth; GitHub only supplies tag + release URL.
    const changes = serviceChangeItems(service)
    const plainChanges = changes.map(formatPlainChange).join('\n')
    const slackChanges = changes.map(formatSlackChange).join('\n')
    const htmlChanges =
      changes.length > 0
        ? `<ul>${changes
            .map((change) => {
              const label = change.issueKey
                ? change.issueUrl
                  ? `<a href="${escapeHtml(change.issueUrl)}">${escapeHtml(change.issueKey)}</a>: ${escapeHtml(change.title)}`
                  : `${escapeHtml(change.issueKey)}: ${escapeHtml(change.title)}`
                : escapeHtml(change.title)
              const author = formatHtmlAuthor(change.author)
              if (change.url) {
                return `<li>${label}${author} in <a href="${escapeHtml(change.url)}">PR</a></li>`
              }
              return `<li>${label}${author}</li>`
            })
            .join('')}</ul>`
        : ''

    if (!release) {
      const emptyPlain = plainChanges || 'No tickets linked to this service.'
      const emptySlack = slackChanges || '_No tickets linked to this service._'
      plainSections.push(`${serviceName}\nTag: Not created\n${emptyPlain}`)
      // Space after * so Slack mrkdwn bold is not broken by the following colon.
      slackSections.push(`*${serviceName}* : _Not created_\n${emptySlack}`)
      htmlSections.push(
        `<p><b>${escapeHtml(serviceName)}</b>: <i>Not created</i></p>${htmlChanges || '<p><i>No tickets linked to this service.</i></p>'}`,
      )
      continue
    }

    const descriptionPlain =
      plainChanges || 'No tickets linked to this service.'
    const descriptionSlack =
      slackChanges || '_No tickets linked to this service._'
    const descriptionHtml =
      htmlChanges || '<p><i>No tickets linked to this service.</i></p>'

    plainSections.push(
      `${serviceName}\nTag: ${release.tag}\n${release.url}\n${descriptionPlain}`,
    )
    slackSections.push(
      `*${serviceName}* : <${release.url}|${release.tag}>\n${descriptionSlack}`,
    )
    htmlSections.push(
      `<p><b>${escapeHtml(serviceName)}</b>: <a href="${escapeHtml(release.url)}">${escapeHtml(release.tag)}</a></p>${descriptionHtml}`,
    )
  }

  return {
    plain: `Release Notes\nRelease date: ${releaseDate}\n\n${plainSections.join('\n\n')}`,
    slack: `*Release Notes*\nRelease date: ${releaseDate}\n\n${slackSections.join('\n\n')}`,
    // One blank line between services on Slack HTML paste.
    html: `<p><b>Release Notes</b><br>Release date: ${escapeHtml(releaseDate)}</p>${htmlSections.join('<br>')}`,
  }
}

export function releaseNotesTextForFormat(
  notes: { plain: string; slack: string; html: string },
  format: ReleaseNotesFormat,
) {
  return format === 'slack' ? notes.slack : notes.plain
}

export async function copyReleaseNotesContent(
  notes: { plain: string; slack: string; html: string },
  format: ReleaseNotesFormat,
) {
  const text = releaseNotesTextForFormat(notes, format)
  if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    // text/html gives Slack real bold + hyperlinked tags on paste.
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([notes.html], { type: 'text/html' }),
      }),
    ])
    return
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
}
