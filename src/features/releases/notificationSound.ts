/** Short synthesized alert tones (no audio asset). Unlock on the enable-alerts click. */

type NotificationSoundKind = 'succeeded' | 'failed' | 'canceled' | 'info'

let audioContext: AudioContext | null = null

function getAudioContext() {
  if (typeof window === 'undefined') return null
  const AudioContextCtor =
    window.AudioContext ??
    (
      window as typeof window & {
        webkitAudioContext?: typeof AudioContext
      }
    ).webkitAudioContext
  if (!AudioContextCtor) return null
  audioContext ??= new AudioContextCtor()
  return audioContext
}

export async function unlockNotificationSound() {
  const context = getAudioContext()
  if (!context) return
  if (context.state === 'suspended') {
    await context.resume()
  }
}

function tone(
  context: AudioContext,
  {
    frequency,
    startAt,
    duration,
    type = 'sine',
    gain = 0.08,
  }: {
    frequency: number
    startAt: number
    duration: number
    type?: OscillatorType
    gain?: number
  },
) {
  const oscillator = context.createOscillator()
  const envelope = context.createGain()
  oscillator.type = type
  oscillator.frequency.value = frequency
  envelope.gain.setValueAtTime(0.0001, startAt)
  envelope.gain.exponentialRampToValueAtTime(gain, startAt + 0.02)
  envelope.gain.exponentialRampToValueAtTime(0.0001, startAt + duration)
  oscillator.connect(envelope)
  envelope.connect(context.destination)
  oscillator.start(startAt)
  oscillator.stop(startAt + duration + 0.02)
}

export function playNotificationSound(kind: string = 'info') {
  const context = getAudioContext()
  if (!context) return

  const soundKind: NotificationSoundKind =
    kind === 'succeeded' || kind === 'failed' || kind === 'canceled'
      ? kind
      : 'info'

  void context.resume().then(() => {
    const now = context.currentTime
    if (soundKind === 'succeeded') {
      tone(context, { frequency: 880, startAt: now, duration: 0.12 })
      tone(context, {
        frequency: 1174.66,
        startAt: now + 0.1,
        duration: 0.18,
      })
      return
    }
    if (soundKind === 'failed') {
      tone(context, {
        frequency: 220,
        startAt: now,
        duration: 0.16,
        type: 'triangle',
        gain: 0.09,
      })
      tone(context, {
        frequency: 165,
        startAt: now + 0.12,
        duration: 0.22,
        type: 'triangle',
        gain: 0.09,
      })
      return
    }
    tone(context, {
      frequency: 660,
      startAt: now,
      duration: 0.14,
      gain: 0.06,
    })
  })
}
