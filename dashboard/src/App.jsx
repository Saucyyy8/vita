import React from 'react';
import { BrowserRouter as Router, Routes, Route, Link, useLocation } from 'react-router-dom';
import { Map, ServerIcon, Route as RouteIcon, AlertTriangle, LogOut, Activity } from 'lucide-react';
import { useAuth } from './context/AuthContext';
import { auth } from './api/firebaseConfig';
import { signOut } from 'firebase/auth';

import ProtectedRoute from './components/ProtectedRoute';
import LoginPage from './pages/LoginPage';
import MapPage from './pages/MapPage';
import InfraPage from './pages/InfraPage';
import CreateTripPage from './pages/CreateTripPage';
import ChaosPage from './pages/ChaosPage';
import SimulationPage from './pages/SimulationPage';
import GlobalAlertBanner from './components/GlobalAlertBanner';

function Sidebar() {
  const { currentUser } = useAuth();
  const location = useLocation();

  if (!currentUser) return null;

  const handleLogout = () => {
    signOut(auth);
  };

  const navItems = [
    { path: '/map', label: 'Live Map', icon: Map },
    { path: '/infrastructure', label: 'Infrastructure', icon: ServerIcon },
    { path: '/trips/create', label: 'Create Trip', icon: RouteIcon },
    { path: '/chaos', label: 'Chaos Panel', icon: AlertTriangle },
    { path: '/simulations', label: 'Simulations', icon: Activity }
  ];

  return (
    <div style={{ 
      width: '220px', minWidth: '220px', display: 'flex', flexDirection: 'column', 
      padding: '1.5rem', margin: '0', 
      background: '#0f172a', borderRight: '1px solid rgba(255,255,255,0.08)',
      height: '100vh', position: 'sticky', top: 0
    }}>
      <div style={{ marginBottom: '2rem' }}>
        <h2 style={{ background: 'linear-gradient(to right, #60a5fa, #a78bfa)', WebkitBackgroundClip: 'text', color: 'transparent', fontWeight: 'bold', fontSize: '1.2rem' }}>
          VITA Admin
        </h2>
        <div style={{ display: 'inline-block', marginTop: '0.5rem', padding: '0.2rem 0.6rem', borderRadius: '9999px', fontSize: '0.65rem', fontWeight: 600, background: 'rgba(34,197,94,0.15)', color: '#22c55e' }}>SECURED</div>
      </div>

      <nav style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = location.pathname === item.path;
          return (
            <Link
              key={item.path}
              to={item.path}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.7rem 0.85rem',
                borderRadius: '8px', textDecoration: 'none', fontSize: '0.85rem',
                background: isActive ? 'rgba(59, 130, 246, 0.2)' : 'transparent',
                color: isActive ? '#60a5fa' : '#94a3b8',
                transition: 'all 0.2s', fontWeight: isActive ? '600' : '500'
              }}
            >
              <Icon size={18} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <button onClick={handleLogout} style={{ 
        width: '100%', display: 'flex', alignItems: 'center', gap: '0.5rem',
        justifyContent: 'flex-start', color: '#ef4444', background: 'transparent',
        border: '1px solid rgba(239,68,68,0.2)', borderRadius: '8px', 
        padding: '0.7rem 0.85rem', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 500,
        fontFamily: 'var(--font-family)'
      }}>
        <LogOut size={18} /> Logout
      </button>
    </div>
  );
}

export default function App() {
  return (
    <Router>
      <div className="app-container">
        {/* Aceternity Aurora Background */}
        <div className="aurora-bg">
          <div className="aurora-layer"></div>
        </div>
        <GlobalAlertBanner />
        <Sidebar />
        <main className="main-content">
          <Routes>
            <Route path="/" element={<LoginPage />} />
            <Route 
              path="/map" 
              element={
                <ProtectedRoute>
                  <MapPage />
                </ProtectedRoute>
              } 
            />
            <Route 
              path="/infrastructure" 
              element={
                <ProtectedRoute adminOnly={false}>
                  <InfraPage />
                </ProtectedRoute>
              } 
            />
            <Route 
              path="/trips/create" 
              element={
                <ProtectedRoute adminOnly={false}>
                  <CreateTripPage />
                </ProtectedRoute>
              } 
            />
            <Route 
              path="/chaos" 
              element={
                <ProtectedRoute adminOnly={false}>
                  <ChaosPage />
                </ProtectedRoute>
              } 
            />
            <Route 
              path="/simulations" 
              element={
                <ProtectedRoute adminOnly={false}>
                  <SimulationPage />
                </ProtectedRoute>
              } 
            />
          </Routes>
        </main>
      </div>
    </Router>
  );
}
