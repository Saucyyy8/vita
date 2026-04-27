import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function ProtectedRoute({ children, adminOnly = false }) {
  const { currentUser, isAdmin } = useAuth();

  if (!currentUser) {
    return <Navigate to="/" replace />;
  }

  if (adminOnly && !isAdmin) {
    return (
      <div className="glass-panel" style={{ padding: '2rem', margin: '2rem', textAlign: 'center' }}>
        <h2 style={{color: 'var(--danger)'}}>Access Denied</h2>
        <p>You need administrator privileges to view this page.</p>
      </div>
    );
  }

  return children;
}
