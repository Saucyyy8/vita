import React, { useState, useEffect, useRef } from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../api/firebaseConfig';
import { motion } from 'framer-motion';
import { Route, Plus, Trash2, ArrowUp, ArrowDown, Truck } from 'lucide-react';
import { useJsApiLoader, Autocomplete } from '@react-google-maps/api';

const libraries = ['places', 'geometry'];

export default function CreateTripPage() {
  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY,
    libraries
  });

  const [infra, setInfra] = useState({ factories: {}, cold_storage: {} });
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState([]);

  // Fetch Factories & Cold Storage via Cloud Function (bypasses DB rules)
  useEffect(() => {
    const fetchInfra = async () => {
      try {
        const getInfraFn = httpsCallable(functions, 'getInfrastructure');
        const result = await getInfraFn();
        console.log('[CreateTripPage] Loaded infrastructure:', result.data);
        setInfra({
          factories: result.data.factories || {},
          cold_storage: result.data.cold_storage || {}
        });
      } catch (err) {
        console.error('[CreateTripPage] Failed to load infrastructure:', err);
      }
    };
    fetchInfra();
  }, []);

  const activeFacs = Object.entries(infra.factories).filter(([_, v]) => v.status === 'ACTIVE');
  const activeCS = Object.entries(infra.cold_storage).filter(([_, v]) => v.status === 'ACTIVE');

  // Main state: Array of truck dispatch operations
  const [fleets, setFleets] = useState([
    {
      id: Date.now(),
      truckId: '',
      driverUid: '',
      cargoType: 'VACCINES',
      waypoints: [
        { type: 'FACTORY', refId: '', name: '', lat: '', lng: '' },
        { type: 'CUSTOM', refId: '', name: '', lat: '', lng: '' }
      ]
    }
  ]);

  // Refs for tracking Google Autocomplete instances matrix
  // autocompleteRefs.current[fleetIndex][wpIndex]
  const autocompleteRefs = useRef({}); 

  const addFleet = () => {
    setFleets([...fleets, {
      id: Date.now(),
      truckId: '', driverUid: '', cargoType: 'VACCINES',
      waypoints: [{ type: 'FACTORY', refId: '', name: '', lat: '', lng: '' }, { type: 'CUSTOM', refId: '', name: '', lat: '', lng: '' }]
    }]);
  };

  const removeFleet = (fleetIndex) => {
    setFleets(fleets.filter((_, i) => i !== fleetIndex));
  };

  const updateFleetField = (fleetIndex, field, value) => {
    const updated = [...fleets];
    updated[fleetIndex][field] = value;
    setFleets(updated);
  };

  const addWaypoint = (fleetIndex) => {
    const updated = [...fleets];
    updated[fleetIndex].waypoints.push({ type: 'CUSTOM', refId: '', name: '', lat: '', lng: '' });
    setFleets(updated);
  };

  const removeWaypoint = (fleetIndex, wpIndex) => {
    const updated = [...fleets];
    updated[fleetIndex].waypoints = updated[fleetIndex].waypoints.filter((_, i) => i !== wpIndex);
    setFleets(updated);
  };

  const moveWaypoint = (fleetIndex, wpIndex, direction) => {
    const updated = [...fleets];
    const wps = updated[fleetIndex].waypoints;
    if (direction === -1 && wpIndex > 0) {
      [wps[wpIndex - 1], wps[wpIndex]] = [wps[wpIndex], wps[wpIndex - 1]];
    } else if (direction === 1 && wpIndex < wps.length - 1) {
      [wps[wpIndex + 1], wps[wpIndex]] = [wps[wpIndex], wps[wpIndex + 1]];
    }
    setFleets(updated);
  };

  const handleWaypointChange = (fleetIndex, wpIndex, payload) => {
    const updated = [...fleets];
    updated[fleetIndex].waypoints[wpIndex] = { ...updated[fleetIndex].waypoints[wpIndex], ...payload };
    setFleets(updated);
  };

  const handleNodeSelect = (fleetIndex, wpIndex, type, refId) => {
    const nodeData = type === 'FACTORY' ? infra.factories[refId] : infra.cold_storage[refId];
    if (nodeData) {
      handleWaypointChange(fleetIndex, wpIndex, { type, refId, name: nodeData.name || refId, lat: nodeData.lat, lng: nodeData.lng });
    } else {
      handleWaypointChange(fleetIndex, wpIndex, { type, refId });
    }
  };

  const onPlaceChanged = (fleetIndex, wpIndex) => {
    const autocomplete = autocompleteRefs.current[`${fleetIndex}_${wpIndex}`];
    if (autocomplete != null) {
      const place = autocomplete.getPlace();
      if (place && place.geometry && place.geometry.location) {
        handleWaypointChange(fleetIndex, wpIndex, {
          name: place.formatted_address || place.name || '',
          lat: place.geometry.location.lat(),
          lng: place.geometry.location.lng()
        });
      }
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    // Validation
    for (let f=0; f<fleets.length; f++) {
      let fleet = fleets[f];
      if (fleet.waypoints.length < 2) return alert(`Truck ${fleet.truckId || f+1} must have at least 2 stops.`);
      
      for (let w=0; w<fleet.waypoints.length; w++) {
        let wp = fleet.waypoints[w];
        if (!wp.lat || !wp.lng) {
          return alert(`Truck ${fleet.truckId || f+1}, Stop ${w+1} is missing valid coordinates! Select a node or autocomplete location.`);
        }
      }
    }

    setLoading(true);
    setMessages([]);
    let logs = [];

    const createTripFn = httpsCallable(functions, 'createMultiStopTrip');

    for (let i = 0; i < fleets.length; i++) {
        try {
            const fleet = fleets[i];
            const payload = {
                assigned_truck_id: fleet.truckId,
                assigned_driver_uid: fleet.driverUid,
                cargo_type: fleet.cargoType,
                waypoints: fleet.waypoints.map(wp => ({
                    name: wp.name,
                    lat: parseFloat(wp.lat),
                    lng: parseFloat(wp.lng)
                }))
            };
            const response = await createTripFn(payload);
            logs.push({ text: `Truck ${fleet.truckId} deployed! Trip ID: ${response.data.trip_id}`, type: 'success' });
        } catch (err) {
            logs.push({ text: `Truck ${fleets[i].truckId} failed: ${err.message}`, type: 'error' });
        }
    }

    setMessages(logs);
    setLoading(false);
    
    // Reset if fully successful
    if (logs.every(l => l.type === 'success')) {
      setFleets([{
        id: Date.now(), truckId: '', driverUid: '', cargoType: 'VACCINES',
        waypoints: [{ type: 'FACTORY', refId: '', name: '', lat: '', lng: '' }, { type: 'CUSTOM', refId: '', name: '', lat: '', lng: '' }]
      }]);
    }
  };

  if (!isLoaded) return <div className="glass-panel" style={{ padding: '2rem', textAlign: 'center' }}>Loading Maps Toolkit...</div>;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Deploy Fleet Operations</h1>
        <button onClick={addFleet} className="btn-secondary">
          <Truck size={18} /> Add Another Truck
        </button>
      </div>
      
      {messages.length > 0 && (
        <div style={{ marginBottom: '2rem' }}>
          {messages.map((m, i) => (
             <div key={i} className={`badge ${m.type === 'success' ? 'success' : 'danger'}`} style={{ display: 'block', padding: '1rem', marginBottom: '0.5rem', borderRadius: '8px' }}>
               {m.text}
             </div>
          ))}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        {fleets.map((fleet, fleetIndex) => (
          <div key={fleet.id} className="glass-panel" style={{ marginBottom: '2rem', padding: '2.5rem', position: 'relative' }}>
            
            {fleets.length > 1 && (
              <button type="button" onClick={() => removeFleet(fleetIndex)} className="btn-danger" style={{ position: 'absolute', top: '15px', right: '15px', padding: '0.5rem' }}>
                <Trash2 size={16} /> Remove Truck
              </button>
            )}

            <h3 style={{ marginTop: 0, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
               <Truck size={20} /> Truck {fleetIndex + 1} Assignment
            </h3>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1.5rem', marginTop: '1.5rem' }}>
              <div className="form-group">
                <label>Assigned Truck ID</label>
                <input required value={fleet.truckId} onChange={e => updateFleetField(fleetIndex, 'truckId', e.target.value)} placeholder="e.g., TRK-999" />
              </div>
              <div className="form-group">
                <label>Driver UID</label>
                <input required value={fleet.driverUid} onChange={e => updateFleetField(fleetIndex, 'driverUid', e.target.value)} placeholder="e.g., driver_001" />
              </div>
              <div className="form-group">
                <label>Cargo Classification</label>
                <select required value={fleet.cargoType} onChange={e => updateFleetField(fleetIndex, 'cargoType', e.target.value)}>
                  <option value="VACCINES">Vaccines (Strict Temp 2-8°C)</option>
                  <option value="FROZEN_FOOD">Frozen Food (-18°C)</option>
                  <option value="PRODUCE">Fresh Produce (4-10°C)</option>
                  <option value="NORMAL_PACKAGE">📦 Normal Package (No Temp Control)</option>
                </select>
              </div>
            </div>

            <div style={{ marginTop: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h4 style={{ margin: 0, color: '#9ca3af' }}>Routing Sequence</h4>
              <button type="button" onClick={() => addWaypoint(fleetIndex)} className="btn-ghost" style={{ padding: '0.4rem 0.8rem' }}>
                <Plus size={16} /> Add Routing Node
              </button>
            </div>

            <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {fleet.waypoints.map((wp, wpIndex) => (
                <div key={wpIndex} style={{ display: 'flex', gap: '1rem', padding: '1.5rem', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '12px', alignItems: 'center', border: '1px solid rgba(255,255,255,0.05)' }}>
                  
                  {/* Reordering Controls */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <button type="button" onClick={() => moveWaypoint(fleetIndex, wpIndex, -1)} disabled={wpIndex === 0} style={{ opacity: wpIndex === 0 ? 0.2 : 1, cursor: 'pointer', background: 'none', border: 'none', color: 'white' }}>
                      <ArrowUp size={20} />
                    </button>
                    <button type="button" onClick={() => moveWaypoint(fleetIndex, wpIndex, 1)} disabled={wpIndex === fleet.waypoints.length - 1} style={{ opacity: wpIndex === fleet.waypoints.length - 1 ? 0.2 : 1, cursor: 'pointer', background: 'none', border: 'none', color: 'white' }}>
                      <ArrowDown size={20} />
                    </button>
                  </div>

                  <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                    <label style={{ fontSize: '0.8rem' }}>Location Type</label>
                    <select value={wp.type} onChange={(e) => handleWaypointChange(fleetIndex, wpIndex, { type: e.target.value, name: '', lat: '', lng: '', refId: '' })}>
                      <option value="FACTORY">🏢 Active Factory</option>
                      <option value="COLD_STORAGE">❄️ Cold Storage</option>
                      <option value="CUSTOM">📍 Custom Address</option>
                    </select>
                  </div>

                  <div className="form-group" style={{ flex: 2, marginBottom: 0 }}>
                    <label style={{ fontSize: '0.8rem' }}>Search / Select Location</label>
                    
                    {wp.type === 'FACTORY' && (
                      <select required value={wp.refId} onChange={e => handleNodeSelect(fleetIndex, wpIndex, 'FACTORY', e.target.value)}>
                         <option value="" disabled>Select Factory...</option>
                         {activeFacs.map(([id, f]) => <option key={id} value={id}>{f.name || id}</option>)}
                      </select>
                    )}

                    {wp.type === 'COLD_STORAGE' && (
                      <select required value={wp.refId} onChange={e => handleNodeSelect(fleetIndex, wpIndex, 'COLD_STORAGE', e.target.value)}>
                         <option value="" disabled>Select Cold Storage...</option>
                         {activeCS.map(([id, cs]) => <option key={id} value={id}>{cs.name || id}</option>)}
                      </select>
                    )}

                    {wp.type === 'CUSTOM' && (
                      <Autocomplete
                        onLoad={ac => autocompleteRefs.current[`${fleetIndex}_${wpIndex}`] = ac}
                        onPlaceChanged={() => onPlaceChanged(fleetIndex, wpIndex)}
                      >
                        <input
                          type="text"
                          placeholder="Search Google Maps..."
                          value={wp.name}
                          onChange={(e) => handleWaypointChange(fleetIndex, wpIndex, { name: e.target.value })}
                          required
                        />
                      </Autocomplete>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <div className="form-group" style={{ marginBottom: 0, opacity: 0.7, width: '90px' }}>
                      <label style={{ fontSize: '0.7rem' }}>Lat</label>
                      <input readOnly value={wp.lat ? Number(wp.lat).toFixed(4) : ''} style={{ padding: '0.5rem', fontSize: '0.8rem' }} placeholder="--" />
                    </div>
                    <div className="form-group" style={{ marginBottom: 0, opacity: 0.7, width: '90px' }}>
                      <label style={{ fontSize: '0.7rem' }}>Lng</label>
                      <input readOnly value={wp.lng ? Number(wp.lng).toFixed(4) : ''} style={{ padding: '0.5rem', fontSize: '0.8rem' }} placeholder="--" />
                    </div>
                  </div>

                  {fleet.waypoints.length > 2 && (
                    <button type="button" onClick={() => removeWaypoint(fleetIndex, wpIndex)} className="btn-danger" style={{ padding: '0.8rem', marginTop: '1.2rem', marginLeft: '0.5rem' }} title="Remove Stop">
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}

        <button type="submit" className="btn-primary" disabled={loading} style={{ width: '100%', padding: '1.5rem', fontSize: '1.2rem', fontWeight: 'bold' }}>
            {loading ? 'Transmitting Logistics to Core...' : '🚀 Execute Total Fleet Deployment'}
        </button>
      </form>
    </motion.div>
  );
}
