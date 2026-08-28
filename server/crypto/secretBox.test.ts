import { afterEach, describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret } from './secretBox.js'

describe('secretBox', () => {
  afterEach(() => {
    delete process.env.CONNECTION_ENCRYPTION_KEY
  })

  it('round-trips a token', () => {
    process.env.CONNECTION_ENCRYPTION_KEY = 'test-key'
    const encrypted = encryptSecret('jira-token')
    expect(encrypted.equals(Buffer.from('jira-token'))).toBe(false)
    expect(decryptSecret(encrypted)).toBe('jira-token')
  })
})
