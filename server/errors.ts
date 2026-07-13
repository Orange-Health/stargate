export class ProviderError extends Error {
  readonly code: string
  readonly provider?: 'jira' | 'github' | 'jenkins'
  readonly status: number
  readonly retryable: boolean

  constructor(
    message: string,
    code: string,
    provider?: 'jira' | 'github' | 'jenkins',
    status = 500,
    retryable = false,
  ) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.provider = provider
    this.status = status
    this.retryable = retryable
  }
}

export async function providerResponseError(
  response: Response,
  provider: 'jira' | 'github' | 'jenkins',
): Promise<ProviderError> {
  let detail = ''
  try {
    const body = (await response.json()) as {
      message?: string
      errorMessages?: string[]
    }
    detail = body.message ?? body.errorMessages?.join(', ') ?? ''
  } catch {
    // Providers occasionally return HTML for gateway errors.
  }

  const authMessage =
    response.status === 401 || response.status === 403
      ? `Authentication or permission check failed for ${provider}.`
      : `${provider} returned ${response.status}.`
  const message = detail ? `${authMessage} ${detail}` : authMessage

  return new ProviderError(
    message,
    response.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_REQUEST_FAILED',
    provider,
    response.status >= 400 && response.status < 600 ? response.status : 502,
    response.status === 429 || response.status >= 500,
  )
}
