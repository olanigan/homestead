import { useState, useEffect, useCallback, useRef } from "react"
import type { ModelRecord, DashboardData, ObsStats, ServingSession, ServingEvent } from "../types"

const API = ""

export function useModels() {
  const [models, setModels] = useState<ModelRecord[]>([])
  const [loading, setLoading] = useState(true)

  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/models`)
      if (res.ok) setModels(await res.json())
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => { fetchModels() }, [fetchModels])

  return { models, loading, refetch: fetchModels }
}

export function useStatus() {
  const [data, setData] = useState<DashboardData | null>(null)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/status`)
      if (res.ok) setData(await res.json())
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 5000)
    return () => clearInterval(interval)
  }, [fetchStatus])

  return { data, refetch: fetchStatus }
}

export function useObs() {
  const [stats, setStats] = useState<ObsStats | null>(null)
  const [sessions, setSessions] = useState<ServingSession[]>([])
  const [events, setEvents] = useState<ServingEvent[]>([])
  const [selectedSession, setSelectedSession] = useState<string | null>(null)
  const eventsRef = useRef<ServingEvent[]>([])

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/obs/stats`)
      if (res.ok) setStats(await res.json())
    } catch { /* ignore */ }
  }, [])

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/obs/sessions`)
      if (res.ok) setSessions(await res.json())
    } catch { /* ignore */ }
  }, [])

  const fetchEvents = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch(`${API}/api/obs/events?session_id=${sessionId}`)
      if (res.ok) {
        const data = await res.json() as ServingEvent[]
        setEvents(data)
        eventsRef.current = data
      }
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    fetchStats()
    fetchSessions()
    const interval = setInterval(() => {
      fetchStats()
      fetchSessions()
    }, 5000)
    return () => clearInterval(interval)
  }, [fetchStats, fetchSessions])

  useEffect(() => {
    const es = new EventSource(`${API}/api/obs/stream`)
    es.addEventListener("event", (e) => {
      try {
        const event = JSON.parse(e.data) as ServingEvent
        eventsRef.current = [event, ...eventsRef.current].slice(0, 500)
        if (selectedSession === null || event.session_id === selectedSession) {
          setEvents([...eventsRef.current])
        }
      } catch { /* ignore */ }
    })
    es.onerror = () => { /* will auto-reconnect */ }
    return () => es.close()
  }, [selectedSession])

  return {
    stats,
    sessions,
    events,
    selectedSession,
    setSelectedSession: (id: string | null) => {
      setSelectedSession(id)
      if (id) fetchEvents(id)
    },
    refresh: () => { fetchStats(); fetchSessions() },
  }
}

export function useDiscover() {
  const [scanning, setScanning] = useState(false)

  const discover = useCallback(async () => {
    setScanning(true)
    try {
      await fetch(`${API}/api/discover`, { method: "POST" })
    } catch { /* ignore */ }
    setScanning(false)
  }, [])

  return { discover, scanning }
}
