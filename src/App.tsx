import { useEffect, useRef, useState } from 'react'
import './App.css'
import { ConnectionScreen } from './features/connections/ConnectionScreen'
import { ReleaseOverview } from './features/releases/ReleaseOverview'
import { api } from './shared/api'
import { ALL_SERVICES_ID } from './shared/types'
import type {
  ConnectionConfig,
  ConnectionStatus,
  DashboardProgress,
  JiraVersion,
  ReleaseDashboard,
  ReleaseItem,
  ServiceRelease,
} from './shared/types'
import { removeIssueFromDashboard } from './features/releases/releaseTickets'
import { replaceIssueItemsInDashboard } from './shared/releaseDashboard'

function App() {
  const initialSelection = new URLSearchParams(window.location.search)
  const [connection, setConnection] = useState<ConnectionStatus>()
  const [checkingConnection, setCheckingConnection] = useState(true)
  const [releases, setReleases] = useState<JiraVersion[]>([])
  const [selectedVersionId, setSelectedVersionId] = useState(
    () => initialSelection.get('release') ?? '',
  )
  const [selectedRepository, setSelectedRepository] = useState(
    () => initialSelection.get('service') ?? '',
  )
  const [dashboard, setDashboard] = useState<ReleaseDashboard>()
  const [releasesLoading, setReleasesLoading] = useState(false)
  const [dashboardLoading, setDashboardLoading] = useState(false)
  const [error, setError] = useState('')
  const [dashboardProgress, setDashboardProgress] =
    useState<DashboardProgress>()
  const requestSequence = useRef(0)
  const loading = releasesLoading || dashboardLoading

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
    setReleasesLoading(true)
    setError('')
    api
      .releases()
      .then((items) => {
        if (!active) return
        setReleases(items)
        setSelectedVersionId((current) =>
          current === ALL_SERVICES_ID ||
          items.some((item) => item.id === current)
            ? current
            : items[0]?.id || '',
        )
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
        if (active) setReleasesLoading(false)
      })
    return () => {
      active = false
    }
  }, [connection])

  useEffect(() => {
    const url = new URL(window.location.href)
    if (selectedVersionId) {
      url.searchParams.set('release', selectedVersionId)
    } else {
      url.searchParams.delete('release')
    }
    if (selectedRepository) {
      url.searchParams.set('service', selectedRepository)
    } else {
      url.searchParams.delete('service')
    }
    window.history.replaceState(null, '', url)
  }, [selectedRepository, selectedVersionId])

  useEffect(() => {
    if (!selectedVersionId || !connection?.connected) return
    if (selectedVersionId === ALL_SERVICES_ID) {
      setDashboard(undefined)
      setDashboardLoading(false)
      return
    }
    void loadDashboard(selectedVersionId)
  }, [selectedVersionId, connection])

  async function connect(config: ConnectionConfig) {
    const status = await api.connect(config)
    setConnection(status)
    return status
  }

  async function loadDashboard(versionId: string, refresh = false) {
    const sequence = ++requestSequence.current
    const progressId =
      typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `dashboard-${Date.now()}-${sequence}`
    let progressTimer: number | undefined
    let polling = true
    async function pollProgress() {
      if (!polling || sequence !== requestSequence.current) return
      try {
        const progress = await api.dashboardProgress(progressId)
        if (sequence === requestSequence.current) {
          setDashboardProgress(progress)
        }
      } catch {
        // Progress is supplemental; dashboard errors are handled below.
      }
      if (polling) {
        progressTimer = window.setTimeout(pollProgress, 350)
      }
    }
    setDashboardLoading(true)
    setError('')
    setDashboardProgress({
      phase: 'starting',
      message: 'Preparing release data…',
      current: 0,
      total: 1,
    })
    progressTimer = window.setTimeout(pollProgress, 150)
    try {
      const result = await api.dashboard(versionId, refresh, progressId)
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
      polling = false
      if (progressTimer) window.clearTimeout(progressTimer)
      if (sequence === requestSequence.current) {
        setDashboardLoading(false)
        setDashboardProgress(undefined)
      }
    }
  }

  function selectVersion(versionId: string) {
    requestSequence.current += 1
    setDashboard(undefined)
    setError('')
    setDashboardLoading(versionId !== ALL_SERVICES_ID)
    setDashboardProgress(undefined)
    setSelectedRepository('')
    setSelectedVersionId(versionId)
  }

  async function disconnect() {
    requestSequence.current += 1
    await api.disconnect().catch(() => undefined)
    setReleasesLoading(false)
    setDashboardLoading(false)
    setConnection(undefined)
    setReleases([])
    setSelectedVersionId('')
    setSelectedRepository('')
    setDashboard(undefined)
    setError('')
    setDashboardProgress(undefined)
  }

  function updateService(service: ServiceRelease) {
    setDashboard((current) => {
      if (!current) return current
      const index = current.services.findIndex(
        (item) => item.repository === service.repository,
      )
      if (index < 0) return current
      const services = current.services.slice()
      services[index] = service
      return { ...current, services, cached: false }
    })
  }

  function removeIssue(issueKey: string) {
    setDashboard((current) =>
      current ? removeIssueFromDashboard(current, issueKey) : current,
    )
  }

  function updateTicket(issueKey: string, items: ReleaseItem[]) {
    setDashboard((current) =>
      current
        ? replaceIssueItemsInDashboard(current, issueKey, items)
        : current,
    )
  }

  if (checkingConnection) {
    return (
      <main className="boot-state">
        <img className="brand-mark" src="/stargate-logo.png" alt="Stargate" />
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
      dashboardProgress={dashboardProgress}
      error={error}
      onSelectVersion={selectVersion}
      selectedRepository={selectedRepository}
      onSelectRepository={setSelectedRepository}
      onRefresh={() =>
        selectedVersionId === ALL_SERVICES_ID
          ? Promise.resolve()
          : loadDashboard(selectedVersionId, true)
      }
      onServiceUpdated={updateService}
      onIssueRemoved={removeIssue}
      onTicketRefreshed={updateTicket}
      onDisconnect={() => void disconnect()}
    />
  )
}

export default App
