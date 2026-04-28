import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ref, push, set, onValue, serverTimestamp } from 'firebase/database';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '../api/firebaseConfig';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertOctagon, Zap, XCircle, VolumeX, CloudLightning, Truck, Factory, Thermometer, Brain, Loader, CheckCircle, Play, Snowflake } from 'lucide-react';

/**
 * TypewriterText — Renders text character by character with a blinking cursor.
 * Props: text (string), speed (ms per character)
 */
function TypewriterText({ text, speed = 25 }) {
  const [displayedText, setDisplayedText] = useState('');
  const [isComplete, setIsComplete] = useState(false);
  const textRef = useRef(text);

  useEffect(() => {
    // Reset when text changes
    textRef.current = text;
    setDisplayedText('');
    setIsComplete(false);
    
    if (!text) return;

    let i = 0;
    const timer = setInterval(() => {
      if (i < text.length) {
        setDisplayedText(text.substring(0, i + 1));
        i++;
      } else {
        setIsComplete(true);
        clearInterval(timer);
      }
    }, speed);

    return () => clearInterval(timer);
  }, [text, speed]);

  return (
    <p style={{ 
      margin: 0, fontSize: '0.85rem', lineHeight: 1.7, color: 'var(--text-secondary)',
      fontFamily: "'Inter', 'SF Mono', monospace", letterSpacing: '0.01em'
    }}>
      <span style={{ color: 'rgba(255,255,255,0.06)', marginRight: '0.5rem' }}>"</span>
      {displayedText}
      {!isComplete && (
        <motion.span 
          animate={{ opacity: [1, 0] }}
          transition={{ repeat: Infinity, duration: 0.6 }}
          style={{ 
            display: 'inline-block', width: '2px', height: '1em', 
            backgroundColor: '#8b5cf6', marginLeft: '2px', verticalAlign: 'text-bottom' 
          }}
        />
      )}
      <span style={{ color: 'rgba(255,255,255,0.06)', marginLeft: '0.2rem' }}>"</span>
    </p>
  );
}

export default function ChaosPage() {
  const [trips, setTrips] = useState({});
  const [infra, setInfra] = useState({ factories: {}, cold_storage: {} });
  const [agentLogs, setAgentLogs] = useState({});
  const [eventFiring, setEventFiring] = useState('');
  const [toast, setToast] = useState(null);
  
  // Tracks the active anomaly that was fired — persists until AI responds
  const [activeAnomaly, setActiveAnomaly] = useState(null);
  // Tracks the live AI response for the current anomaly
  const [liveAiResponse, setLiveAiResponse] = useState(null);
  
  const [selectedTrip, setSelectedTrip] = useState('');
  const [selectedFactory, setSelectedFactory] = useState('');
  const [selectedColdStorage, setSelectedColdStorage] = useState('');
  const [resumeLoading, setResumeLoading] = useState(null);

  const showToast = useCallback((message, type = 'info') => {
    setToast({ message, type, id: Date.now() });
    setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => {
    const unsubTrips = onValue(ref(db, 'trips'), (s) => setTrips(s.val() || {}));
    const unsubLogs = onValue(ref(db, 'agent_log'), (s) => setAgentLogs(s.val() || {}));
    
    const fetchInfra = async () => {
      try {
        const res = await httpsCallable(functions, 'getInfrastructure')();
        setInfra(res.data);
      } catch (e) { console.error('Failed to load infra:', e); }
    };
    fetchInfra();

    return () => { unsubTrips(); unsubLogs(); };
  }, []);

  // Watch for new agent log entries that match the active anomaly's trip
  // Use a ref to avoid the effect re-triggering itself when updating activeAnomaly
  const activeAnomalyRef = useRef(activeAnomaly);
  activeAnomalyRef.current = activeAnomaly;

  useEffect(() => {
    const anomaly = activeAnomalyRef.current;
    if (!anomaly || anomaly.aiResponded) return;
    
    const logEntries = Object.entries(agentLogs)
      .sort(([,a], [,b]) => (b.timestamp || 0) - (a.timestamp || 0));
    
    // Find the most recent log entry that was created AFTER the anomaly was fired
    const matchingLog = logEntries.find(([, log]) => {
      const isAfterAnomaly = (log.timestamp || 0) >= (anomaly.firedAt || 0) - 5000; // 5s grace
      const matchesTrip = log.trip_id === anomaly.tripId || 
                          log.event_type === anomaly.eventType;
      return isAfterAnomaly && matchesTrip;
    });

    if (matchingLog) {
      const [logId, log] = matchingLog;
      setLiveAiResponse({
        id: logId,
        action: log.action,
        reason: log.reason,
        event_type: log.event_type,
        weather_context: log.weather_context,
        timestamp: log.timestamp
      });
      // Clear the "waiting" state since AI has responded
      setActiveAnomaly(prev => prev ? { ...prev, aiResponded: true } : null);
    }
  }, [agentLogs]);

  const activeTrips = Object.entries(trips).filter(([_, t]) => ['EN_ROUTE', 'PENDING_DRIVER_START', 'REROUTING'].includes(t.status));
  const waitingTrips = Object.entries(trips).filter(([_, t]) => ['WAITING', 'AWAITING_RESCUE_ACCEPTANCE'].includes(t.status));

  const handleResumeTrip = async (tripId, reason) => {
    setResumeLoading(tripId);
    try {
      const res = await httpsCallable(functions, 'resumeTrip')({ trip_id: tripId, reason });
      showToast(res.data.message, 'success');
    } catch (err) {
      showToast('Resume failed: ' + err.message, 'error');
    } finally {
      setResumeLoading(null);
    }
  };

  const fireEvent = async (type, payload, label, haltTripId) => {
    setEventFiring(label);
    try {
      // IMMEDIATELY halt the truck via Cloud Function (bypasses DB rules)
      if (haltTripId) {
        await httpsCallable(functions, 'pauseTrip')({ 
          trip_id: haltTripId, 
          reason: `⚡ ${label} — waiting for AI Agent analysis...` 
        });
      }
      // Set the active anomaly banner
      setActiveAnomaly({
        label,
        eventType: type,
        tripId: payload.trip_id || null,
        truckId: payload.truck_id || selectedTripData?.truck_id || null,
        firedAt: Date.now(),
        aiResponded: false
      });
      setLiveAiResponse(null);

      // Now fire the event for the Master Agent to analyze
      await push(ref(db, 'events'), {
        type,
        label,
        ...payload,
        timestamp: serverTimestamp(),
        is_simulated: true
      });
      showToast(`⚡ ${label} injected successfully`, 'success');
    } catch (e) {
      showToast("Error: " + e.message, 'error');
    } finally {
      setTimeout(() => setEventFiring(''), 5000);
    }
  };

  const clearActiveResponse = () => {
    setActiveAnomaly(null);
    setLiveAiResponse(null);
  };

  const selectedTripData = selectedTrip ? trips[selectedTrip] : null;

  // Recent agent logs
  const recentLogs = Object.entries(agentLogs)
    .sort(([,a], [,b]) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 8);

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
      {/* Toast Notification */}
      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: -20, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: -20, x: '-50%' }}
            style={{
              position: 'fixed', top: '1.5rem', left: '50%',
              zIndex: 9999, padding: '0.85rem 1.5rem', borderRadius: '12px',
              display: 'flex', alignItems: 'center', gap: '0.6rem',
              fontSize: '0.88rem', fontWeight: 600,
              backdropFilter: 'blur(16px)', boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
              background: toast.type === 'success'
                ? 'linear-gradient(135deg, rgba(34,197,94,0.15), rgba(34,197,94,0.08))'
                : toast.type === 'error'
                  ? 'linear-gradient(135deg, rgba(239,68,68,0.15), rgba(239,68,68,0.08))'
                  : 'linear-gradient(135deg, rgba(59,130,246,0.15), rgba(59,130,246,0.08))',
              border: `1px solid ${toast.type === 'success' ? 'rgba(34,197,94,0.3)' : toast.type === 'error' ? 'rgba(239,68,68,0.3)' : 'rgba(59,130,246,0.3)'}`,
              color: toast.type === 'success' ? '#4ade80' : toast.type === 'error' ? '#f87171' : '#60a5fa'
            }}
          >
            {toast.type === 'success' ? <CheckCircle size={18} /> : toast.type === 'error' ? <XCircle size={18} /> : null}
            {toast.message}
          </motion.div>
        )}
      </AnimatePresence>

      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ color: 'var(--warning)' }}>
          <AlertOctagon style={{ display: 'inline', verticalAlign: 'middle', marginRight: '0.5rem' }} /> 
          Chaos Simulation Panel
        </h1>
        <p style={{ color: 'var(--text-secondary)' }}>
          Inject real-world anomalies to test the autonomous AI Agent. The truck will <strong>halt immediately</strong> and wait for the AI's decision.
        </p>
      </div>

      {/* Active Anomaly Banner — persists until AI responds */}
      <AnimatePresence>
        {activeAnomaly && (
          <motion.div
            initial={{ opacity: 0, height: 0, marginBottom: 0 }}
            animate={{ opacity: 1, height: 'auto', marginBottom: '1.5rem' }}
            exit={{ opacity: 0, height: 0, marginBottom: 0 }}
            className="glass-panel"
            style={{
              padding: '1.25rem 1.5rem',
              borderLeft: `4px solid ${activeAnomaly.aiResponded ? '#22c55e' : '#f59e0b'}`,
              background: activeAnomaly.aiResponded
                ? 'linear-gradient(135deg, rgba(34,197,94,0.08), rgba(34,197,94,0.02))'
                : 'linear-gradient(135deg, rgba(245,158,11,0.08), rgba(245,158,11,0.02))',
              overflow: 'hidden'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                {!activeAnomaly.aiResponded ? (
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
                  >
                    <Loader size={20} style={{ color: '#f59e0b' }} />
                  </motion.div>
                ) : (
                  <CheckCircle size={20} style={{ color: '#22c55e' }} />
                )}
                <div>
                  <p style={{ margin: 0, fontWeight: 700, fontSize: '0.95rem', color: activeAnomaly.aiResponded ? '#4ade80' : '#fbbf24' }}>
                    {activeAnomaly.label}
                  </p>
                  <p style={{ margin: '0.2rem 0 0', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                    {activeAnomaly.aiResponded 
                      ? '✅ AI Agent has responded' 
                      : '⏳ Waiting for AI Agent to analyze and decide...'}
                    {activeAnomaly.truckId && <span> — Truck: <strong>{activeAnomaly.truckId}</strong></span>}
                  </p>
                </div>
              </div>
              {activeAnomaly.aiResponded && (
                <button onClick={clearActiveResponse} className="btn-ghost" style={{ padding: '0.4rem 0.8rem', fontSize: '0.75rem' }}>
                  Dismiss
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem' }}>
        
        {/* Transport Anomalies */}
        <div className="glass-panel" style={{ padding: '2rem' }}>
          <h2 style={{ borderBottom: '1px solid var(--glass-border)', paddingBottom: '1rem' }}>🚚 Transport Anomalies</h2>
          
          <div className="form-group" style={{ marginTop: '1.5rem' }}>
            <label>Target Trip</label>
            <select value={selectedTrip} onChange={e => setSelectedTrip(e.target.value)}>
              <option value="">-- Select Active Trip --</option>
              {activeTrips.map(([id, t]) => (
                <option key={id} value={id}>
                  {t.truck_id || id.substring(0,8)} — {t.status} ({t.cargo_type || 'N/A'})
                </option>
              ))}
            </select>
          </div>

          {selectedTrip && (
            <div style={{ padding: '0.75rem', borderRadius: '8px', backgroundColor: 'rgba(59,130,246,0.08)', marginBottom: '1rem', fontSize: '0.8rem' }}>
              <p style={{ margin: 0 }}>📍 Truck: <strong>{selectedTripData?.truck_id}</strong> | Status: <strong>{selectedTripData?.status}</strong></p>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '1rem' }}>
            <button 
              onClick={() => {
                if (!selectedTrip) return showToast("Select a trip first", 'error');
                fireEvent('TRUCK_BREAKDOWN', { 
                  trip_id: selectedTrip, 
                  truck_id: selectedTripData?.truck_id 
                }, '🔧 Truck Engine Failure', selectedTrip);
              }} 
              className="btn-ghost" 
              style={{ borderLeft: '4px solid var(--danger)', justifyContent: 'flex-start' }}
            >
              <Truck size={18} style={{ color: 'var(--danger)' }} /> Engine Seizure & Breakdown
            </button>
            
            <button 
              onClick={() => {
                if (!selectedTrip) return showToast("Select a trip first", 'error');
                fireEvent('SIMULATED_TEMP_BREACH', { 
                  trip_id: selectedTrip, 
                  truck_id: selectedTripData?.truck_id,
                  value: 42, 
                  rule: 8 
                }, '🌡️ Cargo Temperature Spike', selectedTrip);
              }} 
              className="btn-ghost" 
              style={{ borderLeft: '4px solid #ef4444', justifyContent: 'flex-start' }}
            >
              <Thermometer size={18} style={{ color: '#ef4444' }} /> Cold Chain Breach (42°C)
            </button>

            <button 
              onClick={() => {
                if (!selectedTrip) return showToast("Select a trip first", 'error');
                fireEvent('SIMULATED_ROAD_BLOCK', { 
                  trip_id: selectedTrip, 
                  metadata: { location: 'Current truck route segment', desc: 'Severe road blockage — route completely obstructed' } 
                }, '🚧 Severe Road Blockage', selectedTrip);
              }} 
              className="btn-ghost" 
              style={{ borderLeft: '4px solid var(--warning)', justifyContent: 'flex-start' }}
            >
              <XCircle size={18} style={{ color: 'var(--warning)' }} /> Severe Road Blockage
            </button>

            <button 
              onClick={() => {
                if (!selectedTrip) return showToast("Select a trip first", 'error');
                fireEvent('WEATHER_WARNING', { 
                  trip_id: selectedTrip, 
                  condition: "Arctic Blizzard", 
                  severity: "CRITICAL",
                  description: "Sudden arctic blizzard — zero visibility, icy roads, extreme wind gusts"
                }, '🌨️ Sudden Arctic Blizzard', selectedTrip);
              }} 
              className="btn-ghost" 
              style={{ borderLeft: '4px solid #8b5cf6', justifyContent: 'flex-start' }}
            >
              <CloudLightning size={18} style={{ color: '#8b5cf6' }} /> Sudden Arctic Blizzard
            </button>
          </div>
        </div>

        {/* Infrastructure Anomalies */}
        <div className="glass-panel" style={{ padding: '2rem' }}>
          <h2 style={{ borderBottom: '1px solid var(--glass-border)', paddingBottom: '1rem' }}>🏭 Infrastructure Anomalies</h2>
          
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '1.5rem' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Target Factory</label>
              <select value={selectedFactory} onChange={e => setSelectedFactory(e.target.value)}>
                <option value="">-- Select Factory --</option>
                {Object.entries(infra.factories || {}).map(([id, f]) => (
                  <option key={id} value={id}>{f.name || id} ({f.status})</option>
                ))}
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Target Cold Storage</label>
              <select value={selectedColdStorage} onChange={e => setSelectedColdStorage(e.target.value)}>
                <option value="">-- Select Cold Storage --</option>
                {Object.entries(infra.cold_storage || {}).map(([id, cs]) => (
                  <option key={id} value={id}>{cs.name || id} ({cs.status})</option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '1.5rem' }}>
            <button 
              onClick={() => {
                if (!selectedFactory) return showToast("Select a factory first", 'error');
                fireEvent('FACTORY_DOWNTIME_DETECTED', { 
                  factory_id: selectedFactory, 
                  reason: "Catastrophic fire/explosion detected at facility — all operations halted"
                }, '🔥 Factory Fire');
              }} 
              className="btn-ghost" 
              style={{ borderLeft: '4px solid var(--danger)', justifyContent: 'flex-start' }}
            >
              <Factory size={18} style={{ color: 'var(--danger)' }} /> Factory Fire / Explosion
            </button>
            
            <button 
              onClick={() => {
                if (!selectedFactory) return showToast("Select a factory first", 'error');
                fireEvent('SIMULATED_FACTORY_FAILURE', { 
                  factory_id: selectedFactory,
                  reason: "Complete power grid failure — refrigeration & production offline"
                }, '⚡ Grid Failure');
              }} 
              className="btn-ghost" 
              style={{ borderLeft: '4px solid var(--warning)', justifyContent: 'flex-start' }}
            >
              <Zap size={18} style={{ color: 'var(--warning)' }} /> Total Power Grid Failure
            </button>

            <button 
              onClick={() => {
                if (!selectedColdStorage) return showToast("Select a cold storage first", 'error');
                const csData = infra.cold_storage?.[selectedColdStorage];
                fireEvent('COLD_STORAGE_GRID_FAILURE', { 
                  cold_storage_id: selectedColdStorage,
                  cold_storage_name: csData?.name || selectedColdStorage,
                  reason: `Complete power grid failure at cold storage hub '${csData?.name || selectedColdStorage}' — unable to maintain freezing temperatures, all stored cargo at risk`
                }, '❄️ Cold Storage Power Failure');
              }} 
              className="btn-ghost" 
              style={{ borderLeft: '4px solid #06b6d4', justifyContent: 'flex-start' }}
            >
              <Snowflake size={18} style={{ color: '#06b6d4' }} /> Cold Storage Power Failure
            </button>

            <button 
              onClick={async () => {
                if (!selectedFactory) return showToast("Select a factory first", 'error');
                try {
                  const fourHoursAgo = Date.now() - (4 * 60 * 60 * 1000);
                  await set(ref(db, `factory_monitors/factory_mon_${selectedFactory}`), {
                    silence_started_at: fourHoursAgo,
                    triggered_already: false
                  });
                  setEventFiring('🔇 Sensor Dead Zone');
                  showToast('🔇 Sensor Dead Zone injected', 'success');
                  setTimeout(() => setEventFiring(''), 3000);
                } catch (e) { showToast("Error: " + e.message, 'error'); }
              }} 
              className="btn-ghost" 
              style={{ borderLeft: '4px solid #a855f7', justifyContent: 'flex-start' }}
            >
              <VolumeX size={18} style={{ color: '#a855f7' }} /> Sensor Dead Zone
            </button>
          </div>
        </div>
      </div>

      {/* Resume Controls for WAITING trips */}
      {waitingTrips.length > 0 && (
        <div className="glass-panel" style={{ padding: '1.5rem 2rem', marginTop: '1.5rem', borderLeft: '4px solid #22c55e' }}>
          <h3 style={{ margin: '0 0 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#4ade80' }}>
            <Play size={18} /> Resume Halted Trips
          </h3>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 0, marginBottom: '1rem' }}>
            These trips are currently halted (weather shelter, breakdown, or AI decision). Resume them once conditions have cleared.
          </p>
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            {waitingTrips.map(([id, trip]) => (
              <div key={id} style={{ 
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '0.85rem 1rem', borderRadius: '10px',
                background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)'
              }}>
                <div>
                  <strong style={{ fontSize: '0.9rem' }}>⏸️ {trip.truck_id || id.substring(0,8)}</strong>
                  <span style={{ fontSize: '0.75rem', color: '#f59e0b', marginLeft: '0.75rem', fontWeight: 600 }}>{trip.status}</span>
                  <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    {trip.wait_reason || trip.last_reason || 'Halted by AI Agent'}
                  </p>
                </div>
                <button 
                  onClick={() => handleResumeTrip(id, `Conditions cleared — resuming trip for truck ${trip.truck_id}`)}
                  disabled={resumeLoading === id}
                  className="btn-primary"
                  style={{ padding: '0.5rem 1.2rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}
                >
                  <Play size={14} /> {resumeLoading === id ? 'Resuming...' : 'Resume Trip'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Active AI Response Box — Typewriter Effect */}
      <AnimatePresence>
        {liveAiResponse && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="glass-panel"
            style={{
              padding: '1.5rem 2rem', marginTop: '1.5rem',
              borderLeft: '4px solid #8b5cf6',
              background: 'linear-gradient(135deg, rgba(139,92,246,0.1), rgba(59,130,246,0.04))'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Brain size={20} style={{ color: '#8b5cf6' }} />
                <span style={{ fontWeight: 700, color: '#a78bfa', fontSize: '0.95rem' }}>
                  Active AI Response
                </span>
              </div>
              <span style={{
                fontSize: '0.65rem', fontWeight: 600, padding: '0.2rem 0.6rem', borderRadius: '6px',
                background: 'rgba(34,197,94,0.15)', color: '#4ade80'
              }}>
                RESOLVED
              </span>
            </div>
            <div style={{
              padding: '1rem', borderRadius: '10px',
              background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)'
            }}>
              <motion.p 
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.4, delay: 0.1 }}
                style={{ margin: '0 0 0.75rem', fontWeight: 700, fontSize: '0.85rem', color: '#c4b5fd' }}
              >
                🧠 {liveAiResponse.action?.replace(/_/g, ' ').toUpperCase()}
              </motion.p>
              <TypewriterText text={liveAiResponse.reason || ''} speed={25} />
              {liveAiResponse.weather_context && liveAiResponse.weather_context !== 'No location available for weather check.' && (
                <motion.p 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 0.4 }}
                  transition={{ delay: Math.min((liveAiResponse.reason?.length || 0) * 0.025, 4) + 0.5 }}
                  style={{ margin: '0.75rem 0 0', fontSize: '0.72rem', fontStyle: 'italic' }}
                >
                  🌤️ {liveAiResponse.weather_context}
                </motion.p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Agent Decision Log */}
      <div className="glass-panel" style={{ padding: '2rem', marginTop: '1.5rem' }}>
        <h2 style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Brain size={22} style={{ color: '#8b5cf6' }} /> 
          AI Agent Decision Log
          <span style={{ fontSize: '0.7rem', fontWeight: 400, padding: '0.2rem 0.5rem', borderRadius: '6px', background: 'rgba(139,92,246,0.15)', color: '#8b5cf6', marginLeft: 'auto' }}>LIVE</span>
        </h2>
        
        {recentLogs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '3rem', opacity: 0.4 }}>
            <Brain size={48} style={{ marginBottom: '1rem' }} />
            <p>No agent decisions yet. Fire an event above to see the AI respond.</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            {recentLogs.map(([id, log]) => (
              <motion.div 
                key={id} 
                initial={{ opacity: 0, x: -10 }} 
                animate={{ opacity: 1, x: 0 }}
                style={{ 
                  padding: '1rem 1.25rem', borderRadius: '12px', 
                  background: log.action === 'AGENT_ERROR' 
                    ? 'linear-gradient(135deg, rgba(239,68,68,0.08), rgba(239,68,68,0.02))' 
                    : 'linear-gradient(135deg, rgba(139,92,246,0.08), rgba(59,130,246,0.03))',
                  borderLeft: `4px solid ${log.action === 'AGENT_ERROR' ? '#ef4444' : '#8b5cf6'}`
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                  <span style={{ fontWeight: 700, color: log.action === 'AGENT_ERROR' ? '#ef4444' : '#8b5cf6', fontSize: '0.85rem' }}>
                    🧠 {log.action?.replace(/_/g, ' ').toUpperCase()}
                  </span>
                  <span className="badge neutral" style={{ fontSize: '0.65rem' }}>
                    {log.event_type}
                  </span>
                </div>
                <p style={{ margin: 0, fontSize: '0.85rem', lineHeight: 1.5, color: 'var(--text-secondary)' }}>
                  "{log.reason}"
                </p>
                {log.weather_context && log.weather_context !== 'No location available for weather check.' && (
                  <p style={{ margin: '0.5rem 0 0', fontSize: '0.72rem', opacity: 0.4, fontStyle: 'italic' }}>
                    🌤️ {log.weather_context}
                  </p>
                )}
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}
