import React, { useState, useEffect, useCallback, useRef } from 'react';
import { GoogleMap, Polyline, Marker, InfoWindow, useJsApiLoader } from '@react-google-maps/api';
import { ref, onValue } from 'firebase/database';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '../api/firebaseConfig';
import { motion, AnimatePresence } from 'framer-motion';
import { Skull, Play, Brain, CheckCircle, XCircle } from 'lucide-react';

const containerStyle = { width: '100%', height: '100%', borderRadius: '12px' };
const center = { lat: 12.9716, lng: 77.5946 };

const libraries = ['places', 'geometry'];

const STATUS_CONFIG = {
  'PENDING_DRIVER_START': { emoji: '🚀', color: '#3b82f6', label: 'Pending' },
  'EN_ROUTE':            { emoji: '🚚', color: '#22c55e', label: 'En Route' },
  'WAITING':             { emoji: '⏸️', color: '#f59e0b', label: 'Halted — AI Processing' },
  'REROUTING':           { emoji: '⚠️', color: '#ef4444', label: 'Rerouting' },
  'COMPLETED':           { emoji: '✅', color: '#10b981', label: 'Completed' },
  'KILLED':              { emoji: '⬛', color: '#6b7280', label: 'Terminated' },
  'ABORTED':             { emoji: '🛑', color: '#dc2626', label: 'Aborted' },
  'WAITING_BACKUP':      { emoji: '🔧', color: '#f97316', label: 'Awaiting Backup' },
};


// ── Typewriter for AI decisions ──
function TypewriterText({ text, speed = 20 }) {
  const [displayed, setDisplayed] = useState('');
  const [done, setDone] = useState(false);
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
    setDisplayed('');
    setDone(false);
    let i = 0;
    const timer = setInterval(() => {
      if (i < textRef.current.length) { setDisplayed(textRef.current.substring(0, i + 1)); i++; }
      else { setDone(true); clearInterval(timer); }
    }, speed);
    return () => clearInterval(timer);
  }, [text, speed]);
  return (
    <span>
      {displayed}
      {!done && <span style={{ display: 'inline-block', width: '2px', height: '0.9em', backgroundColor: '#8b5cf6', marginLeft: '2px', verticalAlign: 'text-bottom', animation: 'blink 0.6s infinite' }} />}
    </span>
  );
}

export default function MapPage() {
  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY,
    libraries
  });

  const [trips, setTrips] = useState({});
  const [infra, setInfra] = useState({ factories: {}, cold_storage: {} });
  const [selectedTrip, setSelectedTrip] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const [toast, setToast] = useState(null);
  const [latestLog, setLatestLog] = useState(null);
  const [resumeLoading, setResumeLoading] = useState(null);

  const showToast = useCallback((message, type = 'info') => {
    setToast({ message, type, id: Date.now() });
    setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => {
    const unsubTrips = onValue(ref(db, 'trips'), (s) => setTrips(s.val() || {}));
    const unsubInfra = onValue(ref(db, 'infrastructure'), (s) => {
      const val = s.val() || {};
      setInfra({ factories: val.factories || {}, cold_storage: val.cold_storage || {} });
    });
    const unsubLogs = onValue(ref(db, 'agent_log'), (s) => {
      const logs = s.val();
      if (logs) {
        const entries = Object.entries(logs)
          .sort(([,a], [,b]) => (b.timestamp || 0) - (a.timestamp || 0))
          .filter(([, log]) => log.action !== 'AGENT_ERROR');
        setLatestLog(entries[0] ? { id: entries[0][0], ...entries[0][1] } : null);
      }
    });
    return () => { unsubTrips(); unsubInfra(); unsubLogs(); };
  }, []);

  const handleKillTrip = async (tripId) => {
    if (!window.confirm(`Kill trip ${tripId.substring(0,8)}...?`)) return;
    setActionLoading(tripId);
    try {
      await httpsCallable(functions, 'killTrip')({ trip_id: tripId });
      showToast(`Trip ${tripId.substring(0,8)}… terminated successfully.`, 'success');
    } catch (err) {
      showToast('Failed: ' + err.message, 'error');
    } finally { setActionLoading(null); }
  };

  const handleStartSim = async (tripId) => {
    setActionLoading(tripId);
    try {
      const res = await httpsCallable(functions, 'startTripSimulation')({ trip_id: tripId });
      showToast(res.data.message, 'success');
    } catch (err) {
      showToast('Failed: ' + err.message, 'error');
    } finally { setActionLoading(null); }
  };

  const handleResumeTrip = async (tripId) => {
    setResumeLoading(tripId);
    try {
      const res = await httpsCallable(functions, 'resumeTrip')({ trip_id: tripId, reason: 'Conditions cleared — operator resumed trip' });
      showToast(res.data.message, 'success');
    } catch (err) {
      showToast('Resume failed: ' + err.message, 'error');
    } finally { setResumeLoading(null); }
  };

  // Separate trips — KILLED trips are hidden from the map entirely
  const liveTrips = Object.entries(trips).filter(([_, t]) => !['KILLED', 'COMPLETED', 'ABORTED'].includes(t.status));
  const stoppedTrips = Object.entries(trips).filter(([_, t]) => ['KILLED', 'COMPLETED', 'ABORTED'].includes(t.status)).slice(0, 10);

  // Only show active trip markers on map (no dead trips)
  const mapVisibleTrips = Object.entries(trips).filter(([_, t]) => !['KILLED', 'ABORTED', 'COMPLETED'].includes(t.status));



  if (!isLoaded) return <div className="glass-panel" style={{ padding: '2rem', textAlign: 'center' }}>Loading Maps...</div>;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} style={{ position: 'relative' }}>
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h1>Live Command Center</h1>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
           {['PENDING_DRIVER_START', 'EN_ROUTE', 'WAITING', 'REROUTING', 'COMPLETED'].map(key => {
            const cfg = STATUS_CONFIG[key];
            return (
              <span key={key} style={{ fontSize: '0.7rem', color: cfg.color, display: 'flex', alignItems: 'center', gap: '4px', opacity: 0.8 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: cfg.color, display: 'inline-block' }} /> {cfg.label}
              </span>
            );
          })}
        </div>
      </div>

      {/* IoT Sensor Telemetry — Top Bar */}
      <h3 style={{ margin: '0 0 0.6rem', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)' }}>
        📡 IoT Sensor Devices
        <span style={{ fontSize: '0.55rem', padding: '0.12rem 0.4rem', borderRadius: '4px', background: 'rgba(34,197,94,0.12)', color: '#22c55e', fontWeight: 600 }}>ESP32 LIVE</span>
      </h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '0.75rem', marginBottom: '1.25rem' }}>
        {Object.entries(infra.factories || {}).map(([id, f]) => {
          const dB = (65 + Math.random() * 20);
          const temp = (22 + Math.random() * 6);
          return (
            <div key={id} style={{ padding: '0.75rem', borderRadius: '12px', background: 'linear-gradient(135deg, rgba(245,158,11,0.08), rgba(245,158,11,0.02))', border: '1px solid rgba(245,158,11,0.15)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.5rem' }}>
                <span style={{ fontSize: '1rem' }}>🏭</span>
                <strong style={{ fontSize: '0.72rem', color: '#f59e0b' }}>{f.name || id}</strong>
                <span style={{ fontSize: '0.5rem', padding: '0.1rem 0.3rem', borderRadius: '4px', background: 'rgba(34,197,94,0.15)', color: '#22c55e', marginLeft: 'auto' }}>✅</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem' }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ opacity: 0.5, fontSize: '0.6rem' }}>🎙️ Sound</div>
                  <strong style={{ color: '#22c55e' }}>{dB.toFixed(0)} dB</strong>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ opacity: 0.5, fontSize: '0.6rem' }}>🌡️ Temp</div>
                  <strong style={{ color: '#22c55e' }}>{temp.toFixed(1)}°C</strong>
                </div>
              </div>
            </div>
          );
        })}
        {Object.entries(infra.cold_storage || {}).map(([id, cs]) => {
          const temp = (-22 + Math.random() * 6);
          return (
            <div key={id} style={{ padding: '0.75rem', borderRadius: '12px', background: 'linear-gradient(135deg, rgba(100,60,180,0.10), rgba(60,40,120,0.04))', border: '1px solid rgba(100,60,180,0.20)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.5rem' }}>
                <span style={{ fontSize: '1rem' }}>❄️</span>
                <strong style={{ fontSize: '0.72rem', color: '#a78bfa' }}>{cs.name || id}</strong>
                <span style={{ fontSize: '0.5rem', padding: '0.1rem 0.3rem', borderRadius: '4px', background: 'rgba(34,197,94,0.15)', color: '#22c55e', marginLeft: 'auto' }}>❄️</span>
              </div>
              <div style={{ fontSize: '0.7rem', textAlign: 'center' }}>
                <div style={{ opacity: 0.5, fontSize: '0.6rem' }}>🌡️ Core Temp</div>
                <strong style={{ color: '#c4b5fd', fontSize: '0.85rem' }}>{temp.toFixed(1)}°C</strong>
              </div>
            </div>
          );
        })}
        {Object.entries(trips).filter(([, t]) => ['EN_ROUTE', 'WAITING', 'REROUTING'].includes(t.status)).map(([id, trip]) => {
          const cargoTemp = trip.cargo_type === 'VACCINES' ? (-18 + Math.random() * 3) : (4 + Math.random() * 3);
          const speed = trip.status === 'WAITING' ? 0 : (40 + Math.random() * 30);
          const isAlert = speed === 0 || cargoTemp > 10;
          return (
            <div key={id} style={{ padding: '0.75rem', borderRadius: '12px', background: isAlert ? 'linear-gradient(135deg, rgba(239,68,68,0.08), rgba(239,68,68,0.02))' : 'linear-gradient(135deg, rgba(34,197,94,0.08), rgba(34,197,94,0.02))', border: `1px solid ${isAlert ? 'rgba(239,68,68,0.2)' : 'rgba(34,197,94,0.15)'}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.5rem' }}>
                <span style={{ fontSize: '1rem' }}>🚚</span>
                <strong style={{ fontSize: '0.72rem', color: isAlert ? '#ef4444' : '#22c55e' }}>{trip.truck_id || id.substring(0,8)}</strong>
                <span style={{ fontSize: '0.5rem', padding: '0.1rem 0.3rem', borderRadius: '4px', background: isAlert ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.15)', color: isAlert ? '#ef4444' : '#22c55e', marginLeft: 'auto' }}>{isAlert ? '⚠️' : '✅'}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem' }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ opacity: 0.5, fontSize: '0.6rem' }}>📦 Cargo</div>
                  <strong style={{ color: cargoTemp > 10 ? '#ef4444' : '#06b6d4' }}>{cargoTemp.toFixed(1)}°C</strong>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ opacity: 0.5, fontSize: '0.6rem' }}>💨 Speed</div>
                  <strong style={{ color: speed === 0 ? '#ef4444' : '#22c55e' }}>{speed.toFixed(0)} km/h</strong>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: '1.5rem', height: 'calc(100vh - 8rem)' }}>
        {/* Map — only show non-killed trips */}
        <div className="glass-panel" style={{ padding: '4px', overflow: 'hidden' }}>
          <GoogleMap mapContainerStyle={containerStyle} center={center} zoom={11}>
            {Object.entries(infra.factories).map(([id, f]) => {
              if (!f || f.status === 'INACTIVE') return null;
              return <Marker key={`fac-${id}`} position={{ lat: f.lat, lng: f.lng }} label="🏭" title={f.name || id} />;
            })}
            {Object.entries(infra.cold_storage).map(([id, cs]) => {
              if (!cs || cs.status === 'INACTIVE') return null;
              return <Marker key={`cs-${id}`} position={{ lat: cs.lat, lng: cs.lng }} label="❄️" title={cs.name || id} />;
            })}

            {/* Custom Location Markers from Active Trips */}
            {mapVisibleTrips.flatMap(([tripId, trip]) => {
              if (!trip.waypoints) return [];
              return trip.waypoints.map((wp, idx) => {
                const isKnown = [...Object.values(infra.factories || {}), ...Object.values(infra.cold_storage || {})]
                  .some(f => Math.abs(parseFloat(f.lat) - parseFloat(wp.lat)) < 0.0001 && Math.abs(parseFloat(f.lng) - parseFloat(wp.lng)) < 0.0001);
                
                if (isKnown) return null;
                return <Marker key={`custom-${tripId}-${idx}`} position={{ lat: parseFloat(wp.lat), lng: parseFloat(wp.lng) }} label="📍" title={wp.name || "Custom Delivery Location"} />;
              });
            })}

            {mapVisibleTrips.map(([id, trip]) => {
              if (!trip || !trip.current_location) return null;
              const path = trip.encoded_polyline && window.google.maps.geometry
                ? window.google.maps.geometry.encoding.decodePath(trip.encoded_polyline) : [];
              const cfg = STATUS_CONFIG[trip.status] || STATUS_CONFIG['EN_ROUTE'];
              return (
                <React.Fragment key={id}>
                  <Marker position={trip.current_location} label={cfg.emoji} onClick={() => setSelectedTrip({ id, ...trip })} zIndex={100} />
                  {path.length > 0 && <Polyline path={path} options={{ strokeColor: cfg.color, strokeWeight: 5, strokeOpacity: 0.8 }} />}
                </React.Fragment>
              );
            })}
            {selectedTrip && selectedTrip.current_location && (
              <InfoWindow position={selectedTrip.current_location} onCloseClick={() => setSelectedTrip(null)}>
                <div style={{ color: '#000', minWidth: '220px', padding: '0.5rem', maxWidth: '320px' }}>
                  <h3 style={{ margin: '0 0 0.5rem 0' }}>🚚 {selectedTrip.truck_id || 'Unknown'}</h3>
                  <p style={{ margin: '0 0 0.25rem 0' }}>Status: <strong style={{ color: (STATUS_CONFIG[selectedTrip.status] || {}).color }}>{selectedTrip.status}</strong></p>
                  <p style={{ margin: '0 0 0.25rem 0' }}>Cargo: <strong>{selectedTrip.cargo_type}</strong></p>
                  {selectedTrip.cargo_compromised && (
                    <p style={{ margin: '0 0 0.25rem 0', color: '#ef4444', fontWeight: 700 }}>⚠️ CARGO COMPROMISED</p>
                  )}
                  {selectedTrip.last_agent_decision && (
                    <div style={{ marginTop: '0.5rem', padding: '0.5rem', backgroundColor: '#f3f4f6', borderRadius: '8px', borderLeft: '3px solid #8b5cf6' }}>
                      <p style={{ margin: 0, fontSize: '0.7rem', color: '#6d28d9', fontWeight: 700 }}>🧠 AI Decision</p>
                      <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: '#374151', lineHeight: 1.4 }}>
                        {selectedTrip.last_agent_decision.reason}
                      </p>
                    </div>
                  )}
                </div>
              </InfoWindow>
            )}
          </GoogleMap>
        </div>

        {/* Side Panel */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', overflowY: 'auto' }}>
          {/* Active Trips */}
          <div className="glass-panel" style={{ padding: '1.25rem' }}>
            <h3 style={{ margin: '0 0 1rem 0' }}>🟢 Active Trips ({liveTrips.length})</h3>
            {liveTrips.length === 0 && <p style={{ opacity: 0.5, fontSize: '0.85rem' }}>No active trips</p>}
            {liveTrips.map(([id, trip]) => {
              const cfg = STATUS_CONFIG[trip.status] || STATUS_CONFIG['EN_ROUTE'];
              return (
                <div key={id} style={{ padding: '0.75rem', marginBottom: '0.75rem', borderRadius: '10px', backgroundColor: 'rgba(255,255,255,0.03)', border: `1px solid ${cfg.color}22` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                    <strong style={{ fontSize: '0.9rem' }}>{cfg.emoji} {trip.truck_id || id.substring(0,8)}</strong>
                    <span style={{ fontSize: '0.65rem', color: cfg.color, fontWeight: 600 }}>{cfg.label}</span>
                  </div>
                  <p style={{ margin: '0 0 0.25rem', fontSize: '0.72rem', opacity: 0.5 }}>Cargo: {trip.cargo_type || 'N/A'}</p>
                  
                  {trip.last_agent_decision && (
                    <div style={{ margin: '0.5rem 0', padding: '0.35rem 0.5rem', borderRadius: '6px', background: 'linear-gradient(135deg, rgba(139,92,246,0.12), rgba(59,130,246,0.06))', borderLeft: '3px solid #8b5cf6' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '2px' }}>
                        <Brain size={10} style={{ color: '#8b5cf6' }} />
                        <span style={{ fontSize: '0.6rem', color: '#8b5cf6', fontWeight: 700 }}>AI</span>
                      </div>
                      <p style={{ margin: 0, fontSize: '0.68rem', color: 'var(--text-secondary)', lineHeight: 1.3 }}>
                        {trip.last_agent_decision.reason?.substring(0, 100)}{trip.last_agent_decision.reason?.length > 100 ? '...' : ''}
                      </p>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                    {trip.status === 'PENDING_DRIVER_START' && (
                      <button onClick={() => handleStartSim(id)} disabled={actionLoading === id} className="btn-primary" style={{ flex: 1, padding: '0.35rem', fontSize: '0.72rem' }}>
                        <Play size={12} /> {actionLoading === id ? '...' : 'Start Sim'}
                      </button>
                    )}
                    {['WAITING', 'AWAITING_RESCUE_ACCEPTANCE'].includes(trip.status) && (
                      <button onClick={() => handleResumeTrip(id)} disabled={resumeLoading === id} className="btn-primary" style={{ flex: 1, padding: '0.35rem', fontSize: '0.72rem', background: '#22c55e' }}>
                        <Play size={12} /> {resumeLoading === id ? 'Resuming...' : 'Resume'}
                      </button>
                    )}
                    <button onClick={() => handleKillTrip(id)} disabled={actionLoading === id} className="btn-danger" style={{ flex: 1, padding: '0.35rem', fontSize: '0.72rem' }}>
                      <Skull size={12} /> {actionLoading === id ? '...' : 'Kill'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* AI Latest Decision */}
          <div className="glass-panel" style={{ padding: '1.25rem', flex: '0 0 auto' }}>
            <h3 style={{ margin: '0 0 0.75rem 0', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Brain size={16} style={{ color: '#8b5cf6' }} /> AI Decision
              <span style={{ fontSize: '0.6rem', padding: '0.15rem 0.4rem', borderRadius: '4px', background: 'rgba(139,92,246,0.15)', color: '#8b5cf6', marginLeft: 'auto' }}>LATEST</span>
            </h3>
            {latestLog ? (
              <div style={{ padding: '0.75rem', borderRadius: '8px', backgroundColor: 'rgba(139,92,246,0.06)', borderLeft: '3px solid #8b5cf6' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#8b5cf6' }}>
                    {latestLog.action?.replace(/_/g, ' ').toUpperCase()}
                  </span>
                  <span style={{ fontSize: '0.6rem', opacity: 0.4 }}>{latestLog.event_type?.replace(/_/g, ' ')}</span>
                </div>
                <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  <TypewriterText text={latestLog.reason || 'No details'} speed={18} />
                </p>
              </div>
            ) : (
              <p style={{ opacity: 0.4, fontSize: '0.8rem' }}>No decisions yet</p>
            )}
          </div>



          {/* Stopped Trips */}
          {stoppedTrips.length > 0 && (
            <div className="glass-panel" style={{ padding: '1.25rem' }}>
              <h3 style={{ margin: '0 0 0.5rem 0', opacity: 0.5 }}>📜 Past ({stoppedTrips.length})</h3>
              {stoppedTrips.map(([id, trip]) => {
                const cfg = STATUS_CONFIG[trip.status] || { emoji: '❓', color: '#6b7280', label: trip.status };
                return (
                  <div key={id} style={{ padding: '0.3rem 0.5rem', marginBottom: '0.3rem', borderRadius: '6px', opacity: 0.4, fontSize: '0.75rem' }}>
                    {cfg.emoji} {trip.truck_id || id.substring(0,8)} — {cfg.label}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
