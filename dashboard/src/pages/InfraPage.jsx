import React, { useState, useEffect, useRef } from 'react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../api/firebaseConfig';
import { motion } from 'framer-motion';
import { Plus, Trash2, MapPin, RefreshCw } from 'lucide-react';
import { useJsApiLoader, Autocomplete } from '@react-google-maps/api';

const libraries = ['places', 'geometry'];

export default function InfraPage() {
  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY,
    libraries
  });

  const [infra, setInfra] = useState({ factories: {}, cold_storage: {} });
  const [showAddForm, setShowAddForm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [successMsg, setSuccessMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

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
      return alert("Please select a location from the Google Maps dropdown so it resolves accurate coordinates.");
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
      alert("Error adding Node: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const renderTable = (data, typeLabel) => (
    <div style={{ overflowX: 'auto' }}>
      <table>
        <thead>
          <tr>
            <th>Name / ID</th>
            <th>Location</th>
            <th>Status</th>
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
            </tr>
          ))}
          {Object.keys(data).length === 0 && (
            <tr><td colSpan="3" style={{ textAlign: 'center', opacity: 0.5 }}>No {typeLabel} found</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
      {successMsg && (
        <div className="badge success" style={{ position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)', zIndex: 1000, padding: '1rem 2rem', fontSize: '1rem', borderRadius: '12px', boxShadow: '0 4px 20px rgba(34,197,94,0.3)' }}>
          ✅ {successMsg}
        </div>
      )}

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
        <div className="badge danger" style={{ display: 'block', padding: '1rem', marginBottom: '1.5rem', borderRadius: '8px' }}>
          ⚠️ {errorMsg}
        </div>
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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem' }}>
          <div className="glass-panel" style={{ padding: '1.5rem' }}>
            <h2>🏭 Factories ({Object.keys(infra.factories).length})</h2>
            {renderTable(infra.factories, 'factories')}
          </div>
          
          <div className="glass-panel" style={{ padding: '1.5rem' }}>
            <h2>❄️ Cold Storage ({Object.keys(infra.cold_storage).length})</h2>
            {renderTable(infra.cold_storage, 'cold storage')}
          </div>
        </div>
      )}
    </motion.div>
  );
}
