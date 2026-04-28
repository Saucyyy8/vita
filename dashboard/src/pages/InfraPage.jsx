import React, { useState, useEffect, useRef } from 'react';
import { httpsCallable } from 'firebase/functions';
import { ref, onValue } from 'firebase/database';
import { db, functions } from '../api/firebaseConfig';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Trash2, MapPin, RefreshCw, Truck, Brain, Play, Zap } from 'lucide-react';
import { useJsApiLoader, Autocomplete } from '@react-google-maps/api';

const libraries = ['places', 'geometry'];

const STATUS_CONFIG = {
  'PENDING_DRIVER_START': { emoji: '🚀', color: '#3b82f6', label: 'Pending' },
  'EN_ROUTE':            { emoji: '🚚', color: '#22c55e', label: 'En Route' },
  'WAITING':             { emoji: '⏸️', color: '#f59e0b', label: 'Halted' },
  'REROUTING':           { emoji: '⚠️', color: '#ef4444', label: 'Rerouting' },
  'COMPLETED':           { emoji: '✅', color: '#10b981', label: 'Completed' },
  'KILLED':              { emoji: '⬛', color: '#6b7280', label: 'Terminated' },
  'ABORTED':             { emoji: '🛑', color: '#dc2626', label: 'Aborted' },
  'AWAITING_RESCUE_ACCEPTANCE': { emoji: '🔧', color: '#f97316', label: 'Awaiting Rescue' },
};

export default function InfraPage() {
  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY,
    libraries
  });

  const [infra, setInfra] = useState({ factories: {}, cold_storage: {} });
  const [trips, setTrips] = useState({});
  const [showAddForm, setShowAddForm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [deleteLoading, setDeleteLoading] = useState(null);
  const [successMsg, setSuccessMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [quickSimLoading, setQuickSimLoading] = useState(false);

  // Form states
  const [type, setType] = useState('factories');
  const [name, setName] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');

  const autocompleteRef = useRef(null);

  // Load infrastructure via Cloud Function (bypasses all DB rules)
  const fetchInfrastructure = async () => {
    setFetching(true);
    setErrorMsg('');
    try {
      const getInfraFn = httpsCallable(functions, 'getInfrastructure');
      const result = await getInfraFn();
      console.log('[InfraPage] Loaded infrastructure:', result.data);
      setInfra({
        factories: result.data.factories || {},
        cold_storage: result.data.cold_storage || {}
      });
    } catch (err) {
      console.error('[InfraPage] Failed to load infrastructure:', err);
      setErrorMsg('Failed to load infrastructure: ' + err.message);
    } finally {
      setFetching(false);
    }
  };

  useEffect(() => {
    fetchInfrastructure();
    // Subscribe to live trip updates
    const unsubTrips = onValue(ref(db, 'trips'), (s) => setTrips(s.val() || {}));
    return () => unsubTrips();
  }, []);

  const onPlaceChanged = () => {
    if (autocompleteRef.current !== null) {
      const place = autocompleteRef.current.getPlace();
      if (place && place.geometry && place.geometry.location) {
        setLat(place.geometry.location.lat());
        setLng(place.geometry.location.lng());
        setName(place.formatted_address || place.name || '');
      }
    }
  };

  const handleAddSubmit = async (e) => {
    e.preventDefault();
    if (!lat || !lng) {
      setErrorMsg("Please select a location from the Google Maps dropdown so it resolves accurate coordinates.");
      return;
    }
    
    setLoading(true);
    try {
      const createNodeFn = httpsCallable(functions, 'createInfrastructureNode');
      const result = await createNodeFn({ type, name, lat, lng });
      
      // Directly update state from the cloud function response
      if (result.data.infrastructure) {
        setInfra({
          factories: result.data.infrastructure.factories || {},
          cold_storage: result.data.infrastructure.cold_storage || {}
        });
      }
      
      setSuccessMsg(`Successfully added ${type === 'factories' ? 'Factory' : 'Cold Storage'}: ${name}!`);
      setTimeout(() => setSuccessMsg(''), 5000);
      
      setShowAddForm(false);
      setName('');
      setLat('');
      setLng('');
    } catch (e) {
      setErrorMsg("Error adding Node: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (nodeType, nodeId, nodeName) => {
    if (!window.confirm(`Delete "${nodeName}"? This cannot be undone.`)) return;
    setDeleteLoading(nodeId);
    try {
      const deleteFn = httpsCallable(functions, 'deleteInfrastructureNode');
      const result = await deleteFn({ type: nodeType, id: nodeId });
      if (result.data.infrastructure) {
        setInfra({
          factories: result.data.infrastructure.factories || {},
          cold_storage: result.data.infrastructure.cold_storage || {}
        });
      }
      setSuccessMsg(`Deleted ${nodeType === 'factories' ? 'Factory' : 'Cold Storage'}: ${nodeName}`);
      setTimeout(() => setSuccessMsg(''), 5000);
    } catch (err) {
      setErrorMsg('Delete failed: ' + err.message);
    } finally {
      setDeleteLoading(null);
    }
  };

  // Active trips with useful info — limit to 10
  const allTrips = Object.entries(trips)
    .sort(([,a], [,b]) => {
      const order = { 'EN_ROUTE': 0, 'WAITING': 1, 'REROUTING': 2, 'PENDING_DRIVER_START': 3, 'COMPLETED': 5, 'KILLED': 6, 'ABORTED': 7 };
      return (order[a.status] ?? 99) - (order[b.status] ?? 99);
    })
    .slice(0, 10);
  const activeTrips = Object.entries(trips).filter(([_, t]) => !['KILLED', 'COMPLETED', 'ABORTED'].includes(t.status));
  const completedTrips = Object.entries(trips).filter(([_, t]) => ['COMPLETED'].includes(t.status));

  // Quick simulate trip handler
  const handleQuickSim = async (originId, originData, destId, destData, originType) => {
    setQuickSimLoading(true);
    try {
      const { push, set, ref: dbRef } = await import('firebase/database');
      const newTripRef = push(dbRef(db, 'trips'));
      await set(newTripRef, {
        truck_id: `sim_${Date.now().toString(36)}`,
        cargo_type: destData.name?.toLowerCase().includes('cold') ? 'VACCINES' : 'NORMAL_PACKAGE',
        status: 'PENDING_DRIVER_START',
        origin: { name: originData.name, lat: originData.lat, lng: originData.lng },
        destination: { name: destData.name, lat: destData.lat, lng: destData.lng },
        waypoints: [
          { lat: originData.lat, lng: originData.lng },
          { lat: destData.lat, lng: destData.lng }
        ],
        created_at: Date.now()
      });
      setSuccessMsg(`✅ Quick trip created: ${originData.name} → ${destData.name}`);
      setTimeout(() => setSuccessMsg(''), 4000);
    } catch (err) {
      setErrorMsg('Failed: ' + err.message);
    } finally {
      setQuickSimLoading(false);
    }
  };

  const renderTable = (data, typeKey, typeLabel) => (
    <div style={{ overflowX: 'auto' }}>
      <table>
        <thead>
          <tr>
            <th>Name / ID</th>
            <th>Location</th>
            <th>Status</th>
            <th style={{ width: '60px', textAlign: 'center' }}></th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(data).map(([id, item]) => (
            <tr key={id}>
              <td style={{ maxWidth: '200px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={item.name || id}>
                {item.name || id}
              </td>
              <td style={{ fontFamily: 'monospace', fontSize: '0.8rem', opacity: 0.7 }}>
                {item.lat ? Number(item.lat).toFixed(4) : '--'}, {item.lng ? Number(item.lng).toFixed(4) : '--'}
              </td>
              <td>
                <span className={`badge ${item.status === 'ACTIVE' ? 'success' : 'neutral'}`}>
                  {item.status || 'UNKNOWN'}
                </span>
              </td>
              <td style={{ textAlign: 'center' }}>
                <button 
                  onClick={() => handleDelete(typeKey, id, item.name || id)}
                  disabled={deleteLoading === id}
                  title="Delete this node"
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer', padding: '0.35rem',
                    borderRadius: '6px', transition: 'all 0.2s',
                    color: deleteLoading === id ? '#6b7280' : '#ef4444',
                    opacity: deleteLoading === id ? 0.4 : 0.6,
                  }}
                  onMouseEnter={e => e.currentTarget.style.opacity = 1}
                  onMouseLeave={e => e.currentTarget.style.opacity = 0.6}
                >
                  <Trash2 size={15} />
                </button>
              </td>
            </tr>
          ))}
          {Object.keys(data).length === 0 && (
            <tr><td colSpan="4" style={{ textAlign: 'center', opacity: 0.5 }}>No {typeLabel} found</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
      <AnimatePresence>
        {successMsg && (
          <motion.div
            initial={{ opacity: 0, y: -20, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: -20, x: '-50%' }}
            style={{
              position: 'fixed', top: '1.5rem', left: '50%', zIndex: 9999,
              padding: '0.85rem 1.5rem', borderRadius: '12px', fontSize: '0.88rem', fontWeight: 600,
              backdropFilter: 'blur(16px)', boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
              background: 'linear-gradient(135deg, rgba(34,197,94,0.15), rgba(34,197,94,0.08))',
              border: '1px solid rgba(34,197,94,0.3)', color: '#4ade80'
            }}
          >
            ✅ {successMsg}
          </motion.div>
        )}
      </AnimatePresence>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <h1>Infrastructure Hub</h1>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <button className="btn-ghost" onClick={fetchInfrastructure} disabled={fetching} title="Refresh">
            <RefreshCw size={18} className={fetching ? 'spinning' : ''} /> Refresh
          </button>
          <button className="btn-primary" onClick={() => setShowAddForm(!showAddForm)}>
            <Plus size={18} /> Add Node
          </button>
        </div>
      </div>

      {errorMsg && (
        <motion.div 
          initial={{ opacity: 0 }} animate={{ opacity: 1 }}
          style={{ padding: '1rem', marginBottom: '1.5rem', borderRadius: '8px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', color: '#f87171', fontSize: '0.85rem' }}
        >
          ⚠️ {errorMsg}
          <button onClick={() => setErrorMsg('')} style={{ float: 'right', background: 'none', border: 'none', color: '#f87171', cursor: 'pointer' }}>✕</button>
        </motion.div>
      )}

      {showAddForm && (
        <div className="glass-panel" style={{ padding: '2rem', marginBottom: '2rem' }}>
          <h2>Add New Node</h2>
          {!isLoaded ? <p>Loading Google Maps API...</p> : (
            <form onSubmit={handleAddSubmit} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label>Node Type</label>
                <select value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="factories">🏭 Factory</option>
                  <option value="cold_storage">❄️ Cold Storage</option>
                </select>
              </div>
              
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label>Search Physical Address</label>
                <Autocomplete
                   onLoad={autocomplete => autocompleteRef.current = autocomplete}
                   onPlaceChanged={onPlaceChanged}
                 >
                   <div style={{ position: 'relative' }}>
                     <MapPin size={18} style={{ position: 'absolute', left: '12px', top: '12px', color: '#9ca3af' }} />
                     <input 
                       required 
                       type="text"
                       value={name} 
                       onChange={e => setName(e.target.value)} 
                       placeholder="e.g., Target Distribution Center" 
                       style={{ paddingLeft: '40px' }}
                     />
                   </div>
                 </Autocomplete>
              </div>

              <div className="form-group">
                <label style={{ opacity: 0.6 }}>Latitude (Auto-filled)</label>
                <input required readOnly type="number" step="any" value={lat} placeholder="..." />
              </div>
              <div className="form-group">
                <label style={{ opacity: 0.6 }}>Longitude (Auto-filled)</label>
                <input required readOnly type="number" step="any" value={lng} placeholder="..." />
              </div>
              
              <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', gap: '1rem', marginTop: '1rem' }}>
                <button type="button" className="btn-ghost" onClick={() => setShowAddForm(false)}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={loading} style={{ padding: '0.8rem 2rem' }}>
                  {loading ? 'Committing to Grid...' : 'Deploy Node'}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {fetching ? (
        <div className="glass-panel" style={{ padding: '3rem', textAlign: 'center', opacity: 0.6 }}>
          Loading infrastructure data from cloud...
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem' }}>
            <div className="glass-panel" style={{ padding: '1.5rem' }}>
              <h2>🏭 Factories ({Object.keys(infra.factories).length})</h2>
              {renderTable(infra.factories, 'factories', 'factories')}
            </div>
            
            <div className="glass-panel" style={{ padding: '1.5rem' }}>
              <h2>❄️ Cold Storage ({Object.keys(infra.cold_storage).length})</h2>
              {renderTable(infra.cold_storage, 'cold_storage', 'cold storage')}
            </div>
          </div>

          {/* Trip Overview Section */}
          <div className="glass-panel" style={{ padding: '1.5rem', marginTop: '2rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
              <h2 style={{ margin: 0 }}>
                <Truck size={22} style={{ verticalAlign: 'middle', marginRight: '0.5rem' }} />
                Fleet Overview (Last 10)
              </h2>
              <div style={{ display: 'flex', gap: '1rem', fontSize: '0.72rem' }}>
                <span style={{ color: '#22c55e' }}>● {activeTrips.length} Active</span>
                <span style={{ color: '#10b981' }}>● {completedTrips.length} Completed</span>
              </div>
            </div>


            {allTrips.length === 0 ? (
              <p style={{ opacity: 0.4, textAlign: 'center', padding: '2rem' }}>No trips yet. Create one from the Create Trip page.</p>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1rem' }}>
                {allTrips
                  .sort(([,a], [,b]) => {
                    const order = { 'EN_ROUTE': 0, 'WAITING': 1, 'REROUTING': 2, 'PENDING_DRIVER_START': 3, 'AWAITING_RESCUE_ACCEPTANCE': 4, 'COMPLETED': 5, 'KILLED': 6, 'ABORTED': 7 };
                    return (order[a.status] ?? 99) - (order[b.status] ?? 99);
                  })
                  .map(([id, trip]) => {
                    const cfg = STATUS_CONFIG[trip.status] || { emoji: '❓', color: '#6b7280', label: trip.status };
                    const isTerminal = ['KILLED', 'COMPLETED', 'ABORTED'].includes(trip.status);
                    return (
                      <motion.div 
                        key={id}
                        initial={{ opacity: 0, scale: 0.97 }}
                        animate={{ opacity: 1, scale: 1 }}
                        style={{
                          padding: '1rem 1.25rem', borderRadius: '12px',
                          background: isTerminal 
                            ? 'rgba(255,255,255,0.01)' 
                            : `linear-gradient(135deg, ${cfg.color}08, ${cfg.color}03)`,
                          border: `1px solid ${cfg.color}${isTerminal ? '11' : '22'}`,
                          borderLeft: `4px solid ${cfg.color}`,
                          opacity: isTerminal ? 0.5 : 1,
                          transition: 'all 0.3s ease'
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <span style={{ fontSize: '1.1rem' }}>{cfg.emoji}</span>
                            <strong style={{ fontSize: '0.9rem' }}>{trip.truck_id || id.substring(0,8)}</strong>
                          </div>
                          <span style={{ 
                            fontSize: '0.65rem', fontWeight: 600, padding: '0.2rem 0.5rem', borderRadius: '6px',
                            background: `${cfg.color}18`, color: cfg.color
                          }}>
                            {cfg.label}
                          </span>
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.3rem 1rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                          <span>📦 <strong>{trip.cargo_type || 'N/A'}</strong></span>
                          <span>🆔 {id.substring(0, 10)}…</span>
                          {trip.current_location && (
                            <span style={{ gridColumn: '1 / -1', fontFamily: 'monospace', fontSize: '0.7rem', opacity: 0.6 }}>
                              📍 {Number(trip.current_location.lat).toFixed(4)}, {Number(trip.current_location.lng).toFixed(4)}
                            </span>
                          )}
                          {trip.cargo_compromised && (
                            <span style={{ gridColumn: '1 / -1', color: '#ef4444', fontWeight: 700, fontSize: '0.72rem' }}>
                              ⚠️ CARGO COMPROMISED
                            </span>
                          )}
                        </div>

                        {trip.last_agent_decision && (
                          <div style={{
                            marginTop: '0.6rem', padding: '0.5rem 0.6rem', borderRadius: '8px',
                            background: 'linear-gradient(135deg, rgba(139,92,246,0.1), rgba(59,130,246,0.04))',
                            borderLeft: '3px solid #8b5cf6'
                          }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '3px' }}>
                              <Brain size={11} style={{ color: '#8b5cf6' }} />
                              <span style={{ fontSize: '0.62rem', color: '#a78bfa', fontWeight: 700 }}>
                                {trip.last_agent_decision.action?.replace(/_/g, ' ').toUpperCase()}
                              </span>
                            </div>
                            <p style={{ margin: 0, fontSize: '0.7rem', color: 'var(--text-secondary)', lineHeight: 1.35 }}>
                              {trip.last_agent_decision.reason?.substring(0, 120)}{trip.last_agent_decision.reason?.length > 120 ? '…' : ''}
                            </p>
                          </div>
                        )}

                        {trip.wait_reason && !isTerminal && (
                          <p style={{ margin: '0.5rem 0 0', fontSize: '0.7rem', color: '#f59e0b', fontStyle: 'italic' }}>
                            ⏸️ {trip.wait_reason.substring(0, 100)}
                          </p>
                        )}
                      </motion.div>
                    );
                  })}
              </div>
            )}
          </div>
        </>
      )}
    </motion.div>
  );
}
