const admin = require('firebase-admin');

admin.initializeApp({
  projectId: 'keen-proton-493005-c7',
  databaseURL: 'https://keen-proton-493005-c7-default-rtdb.firebaseio.com'
});

const db = admin.database();

async function check() {
  const snap = await db.ref('/infrastructure').once('value');
  console.log("INFRASTRUCTURE DATA:", JSON.stringify(snap.val(), null, 2));
  process.exit(0);
}
check();
