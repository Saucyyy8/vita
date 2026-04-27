const admin = require("firebase-admin");
// Download from Firebase Console -> Project Settings -> Service Accounts
const serviceAccount = require("./serviceAccountKey.json"); 

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// Get this from Firebase Console -> Auth
const uid = "REPLACE_WITH_YOUR_USER_UID"; 

admin.auth().setCustomUserClaims(uid, { admin: true })
  .then(() => {
    console.log(`SUCCESS: User ${uid} is now an admin.`);
    process.exit();
  })
  .catch(error => {
    console.error("ERROR setting claim:", error);
    process.exit(1);
  });
