export function productionTagForFormat(tag: string, frontend: boolean) {
  const stagingMatch = /^v-(?:qa|s[1-6])-v(\d{2}\.\d{4}\.\d+)$/.exec(tag)
  const productionMatch = /^(?:v-prod-|v-?)(\d{2}\.\d{4}\.\d+)$/.exec(tag)
  const version = stagingMatch?.[1] ?? productionMatch?.[1]
  if (!version) return tag
  return frontend ? `v-prod-${version}` : `v${version}`
}
