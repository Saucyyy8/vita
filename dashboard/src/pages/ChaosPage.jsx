import React, { useState, useEffect } from 'react';
import { ref, push, set, onValue, serverTimestamp } from 'firebase/database';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '../api/firebaseConfig';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertOctagon, Zap, XCircle, VolumeX, CloudLightning, Truck, Factory, Thermometer, Brain } from 'lucide-react';

export default function ChaosPage() {
  const [trips, setTrips] = useState({});
  const [infra, setInfra] = useState({ factories: {}, cold_storage: {} });
  const [agentLogs, setAgentLogs] = useState({});
  const [eventFiring, setEventFiring] = useState('');
  
  const [selectedTrip, setSelectedTrip] = useState('');
  const [selectedFactory, setSelectedFactory] = useState('');

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

  const activeTrips = Object.entries(trips).filter(([_, t]) => ['EN_ROUTE', 'PENDING_DRIVER_START', 'REROUTING'].includes(t.status));

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
      // Now fire the event for the Master Agent to analyze
      await push(ref(db, 'events'), {
        type,
        label,
        ...payload,
        timestamp: serverTimestamp(),
        is_simulated: true
      });
    } catch (e) {
      alert("Error: " + e.message);
    } finally {
      setTimeout(() => setEventFiring(''), 5000);
    }
  };

  const selectedTripData = selectedTrip ? trips[selectedTrip] : null;

  // Recent agent logs
  const recentLogs = Object.entries(agentLogs)
    .sort(([,a], [,b]) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 8);

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ color: 'var(--warning)' }}>
          <AlertOctagon style={{ display: 'inline', verticalAlign: 'middle', marginRight: '0.5rem' }} /> 
          Chaos Simulation Panel
        </h1>
        <p style={{ color: 'var(--text-secondary)' }}>
          Inject real-world anomalies to test the autonomous AI Agent. The truck will <strong>halt immediately</strong> and wait for the AI's decision.
        </p>
      </div>

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
                if (!selectedTrip) return alert("Select a trip first");
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
                if (!selectedTrip) return alert("Select a trip first");
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
                if (!selectedTrip) return alert("Select a trip first");
                fireEvent('SIMULATED_ROAD_BLOCK', { 
                  trip_id: selectedTrip, 
                  metadata: { location: 'National Highway 44', desc: 'Road collapse — route completely blocked' } 
                }, '🚧 Road Collapse', null);
              }} 
              className="btn-ghost" 
              style={{ borderLeft: '4px solid var(--warning)', justifyContent: 'flex-start' }}
            >
              <XCircle size={18} style={{ color: 'var(--warning)' }} /> Road Collapse (Highway 44)
            </button>

            <button 
              onClick={() => {
                if (!selectedTrip) return alert("Select a trip first");
                fireEvent('WEATHER_WARNING', { 
                  trip_id: selectedTrip, 
                  condition: "Arctic Blizzard", 
                  severity: "CRITICAL",
                  description: "Sudden arctic blizzard — zero visibility, icy roads, extreme wind gusts"
                }, '🌨️ Sudden Arctic Blizzard', null);
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
          
          <div className="form-group" style={{ marginTop: '1.5rem' }}>
            <label>Target Factory</label>
            <select value={selectedFactory} onChange={e => setSelectedFactory(e.target.value)}>
              <option value="">-- Select Factory --</option>
              {Object.entries(infra.factories || {}).map(([id, f]) => (
                <option key={id} value={id}>{f.name || id} ({f.status})</option>
              ))}
            </select>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '1.5rem' }}>
            <button 
              onClick={() => {
                if (!selectedFactory) return alert("Select a factory first");
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
                if (!selectedFactory) return alert("Select a factory first");
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
              onClick={async () => {
                if (!selectedFactory) return alert("Select a factory first");
                try {
                  const fourHoursAgo = Date.now() - (4 * 60 * 60 * 1000);
                  await set(ref(db, `factory_monitors/factory_mon_${selectedFactory}`), {
                    silence_started_at: fourHoursAgo,
                    triggered_already: false
                  });
                  setEventFiring('🔇 Sensor Dead Zone');
                  setTimeout(() => setEventFiring(''), 3000);
                } catch (e) { alert("Error: " + e.message); }
              }} 
              className="btn-ghost" 
              style={{ borderLeft: '4px solid #a855f7', justifyContent: 'flex-start' }}
            >
              <VolumeX size={18} style={{ color: '#a855f7' }} /> Sensor Dead Zone (4hr silence)
            </button>
          </div>
        </div>
      </div>

      {/* Agent Decision Log */}
      <div className="glass-panel" style={{ padding: '2rem', marginTop: '2rem' }}>
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
