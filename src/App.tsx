import { useEffect, useRef, useState } from 'react'
import './App.css'
import { ConnectionScreen } from './features/connections/ConnectionScreen'
import { ReleaseOverview } from './features/releases/ReleaseOverview'
import { api } from './shared/api'
import type {
  ConnectionConfig,
  ConnectionStatus,
  JiraVersion,
  ReleaseDashboard,
} from './shared/types'

function App() {
  const [connection, setConnection] = useState<ConnectionStatus>()
  const [checkingConnection, setCheckingConnection] = useState(true)
  const [releases, setReleases] = useState<JiraVersion[]>([])
  const [selectedVersionId, setSelectedVersionId] = useState('')
  const [dashboard, setDashboard] = useState<ReleaseDashboard>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const requestSequence = useRef(0)

  useEffect(() => {
    api
      .connection()
      .then((status) => setConnection(status.connected ? status : undefined))
      .catch(() => setConnection(undefined))
      .finally(() => setCheckingConnection(false))
  }, [])

  useEffect(() => {
    if (!connection?.connected) return
    let active = true
    setLoading(true)
    setError('')
    api
      .releases()
      .then((items) => {
        if (!active) return
        setReleases(items)
        setSelectedVersionId((current) => current || items[0]?.id || '')
      })
      .catch((reason) => {
        if (active) {
          setError(
            reason instanceof Error
              ? reason.message
              : 'Could not load Jira releases.',
          )
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [connection])

  useEffect(() => {
    if (!selectedVersionId || !connection?.connected) return
    void loadDashboard(selectedVersionId)
  }, [selectedVersionId, connection])

  async function connect(config: ConnectionConfig) {
    const status = await api.connect(config)
    setConnection(status)
    return status
  }

  async function loadDashboard(versionId: string, refresh = false) {
    const sequence = ++requestSequence.current
    setLoading(true)
    setError('')
    try {
      const result = await api.dashboard(versionId, refresh)
      if (sequence === requestSequence.current) setDashboard(result)
    } catch (reason) {
      if (sequence === requestSequence.current) {
        setError(
          reason instanceof Error
            ? reason.message
            : 'Could not build the release dashboard.',
        )
      }
    } finally {
      if (sequence === requestSequence.current) setLoading(false)
    }
  }

  function selectVersion(versionId: string) {
    requestSequence.current += 1
    setDashboard(undefined)
    setError('')
    setLoading(true)
    setSelectedVersionId(versionId)
  }

  async function disconnect() {
    requestSequence.current += 1
    await api.disconnect().catch(() => undefined)
    setConnection(undefined)
    setReleases([])
    setSelectedVersionId('')
    setDashboard(undefined)
    setError('')
  }

  if (checkingConnection) {
    return (
      <main className="boot-state">
        <span className="brand-mark">RD</span>
        <span className="spinner" />
      </main>
    )
  }

  if (!connection?.connected) {
    return <ConnectionScreen onConnect={connect} />
  }

  return (
    <ReleaseOverview
      connection={connection}
      releases={releases}
      selectedVersionId={selectedVersionId}
      dashboard={dashboard}
      loading={loading}
      error={error}
      onSelectVersion={selectVersion}
      onRefresh={() => void loadDashboard(selectedVersionId, true)}
      onDisconnect={() => void disconnect()}
    />
  )
}

export default App
