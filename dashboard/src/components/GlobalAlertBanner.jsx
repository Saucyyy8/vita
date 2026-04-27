import React, { useEffect, useState } from 'react';
import { ref, onValue } from 'firebase/database';
import { db } from '../api/firebaseConfig';
import { motion, AnimatePresence } from 'framer-motion';
import { Brain } from 'lucide-react';

export default function GlobalAlertBanner() {
  const [waitingTrips, setWaitingTrips] = useState([]);

  useEffect(() => {
    const unsub = onValue(ref(db, 'trips'), (snapshot) => {
      const data = snapshot.val() || {};
      const activeWaiting = Object.entries(data).filter(
        ([_, trip]) => trip.status === 'WAITING' && trip.wait_reason?.includes('⚡')
      );
      setWaitingTrips(activeWaiting);
    });
    return () => unsub();
  }, []);

  return (
    <AnimatePresence>
      {waitingTrips.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -40 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -40 }}
          style={{
            position: 'fixed',
            top: '24px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 9999,
            padding: '1rem 2rem',
            borderRadius: '14px',
            background: 'linear-gradient(135deg, rgba(245,158,11,0.95), rgba(239,68,68,0.9))',
            color: 'white',
            fontWeight: 700,
            fontSize: '0.95rem',
            boxShadow: '0 8px 30px rgba(245,158,11,0.4)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            backdropFilter: 'blur(10px)'
          }}
        >
          <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1.5, ease: 'linear' }}>
            <Brain size={20} />
          </motion.div>
          {waitingTrips[0][1].wait_reason}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
