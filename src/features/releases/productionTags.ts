import { usesFrontendProductionTag } from '../../shared/productionRepositories'

const productionTagVersionPattern = /^(?:v-prod-|v-?)(\d{2}\.\d{4}\.\d+)$/

export function productionTagForFormat(tag: string, frontend: boolean) {
  const stagingMatch = /^v-(?:qa|s[1-6])-(\d{2}\.\d{4}\.\d+)$/.exec(tag)
  const productionMatch = productionTagVersionPattern.exec(tag)
  const version = stagingMatch?.[1] ?? productionMatch?.[1]
  if (!version) return tag
  return frontend ? `v-prod-${version}` : `v${version}`
}

export function productionTagVersion(tag: string) {
  return productionTagVersionPattern.exec(tag)?.[1]
}

export function nextPatchProductionTagPreview(
  repository: string,
  latestTag: string | undefined,
) {
  if (!latestTag) return 'Next patch of the latest production tag'
  const version = productionTagVersion(latestTag)
  if (!version) return 'Next patch of the latest production tag'
  const match = /^(\d{2}\.\d{4})\.(\d+)$/.exec(version)
  if (!match) return 'Next patch of the latest production tag'
  const prefix = usesFrontendProductionTag(repository) ? 'v-prod-' : 'v'
  return `${prefix}${match[1]}.${Number(match[2]) + 1}`
}

export function releaseDayProductionTagPreview(
  repository: string,
  date: string,
) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return 'Select a valid date'
  const prefix = usesFrontendProductionTag(repository) ? 'v-prod-' : 'v'
  return `${prefix}${match[1].slice(-2)}.${match[2]}${match[3]}.N`
}
