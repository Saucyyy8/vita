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
    <div className="glass-panel" style={{ width: '250px', display: 'flex', flexDirection: 'column', padding: '1.5rem', margin: '1rem' }}>
      <div style={{ marginBottom: '2rem' }}>
        <h2 style={{ background: 'linear-gradient(to right, #60a5fa, #a78bfa)', WebkitBackgroundClip: 'text', color: 'transparent', fontWeight: 'bold' }}>
          VITA Admin
        </h2>
        <div className="badge success" style={{ display: 'inline-block', marginTop: '0.5rem' }}>Secured</div>
      </div>

      <nav style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = location.pathname === item.path;
          return (
            <Link
              key={item.path}
              to={item.path}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.75rem 1rem',
                borderRadius: '8px', textDecoration: 'none',
                background: isActive ? 'rgba(59, 130, 246, 0.2)' : 'transparent',
                color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                transition: 'all 0.2s', fontWeight: isActive ? '600' : '500'
              }}
            >
              <Icon size={20} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <button onClick={handleLogout} className="btn-ghost" style={{ width: '100%', justifyContent: 'flex-start', color: 'var(--danger)' }}>
        <LogOut size={20} /> Logout
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
                <ProtectedRoute adminOnly={true}>
                  <InfraPage />
                </ProtectedRoute>
              } 
            />
            <Route 
              path="/trips/create" 
              element={
                <ProtectedRoute adminOnly={true}>
                  <CreateTripPage />
                </ProtectedRoute>
              } 
            />
            <Route 
              path="/chaos" 
              element={
                <ProtectedRoute adminOnly={true}>
                  <ChaosPage />
                </ProtectedRoute>
              } 
            />
            <Route 
              path="/simulations" 
              element={
                <ProtectedRoute adminOnly={true}>
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
