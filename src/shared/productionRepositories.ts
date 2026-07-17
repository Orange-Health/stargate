export const FRONTEND_PRODUCTION_REPOSITORIES = [
  'asbru',
  'bifrost',
  'occ-web',
  'sapphire-web',
] as const

export function usesFrontendProductionTag(repository: string) {
  const name = repository.split('/').at(-1)?.toLowerCase()
  return FRONTEND_PRODUCTION_REPOSITORIES.some(
    (frontendRepository) => frontendRepository === name,
  )
}
