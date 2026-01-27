import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, Auth } from 'firebase/auth';
import { getFirestore, Firestore } from 'firebase/firestore';

const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain:
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ??
    (projectId ? `${projectId}.firebaseapp.com` : undefined),
  projectId,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

let firebaseApp: FirebaseApp | null = null;
let firebaseAuth: Auth | null = null;
let firestoreDb: Firestore | null = null;
let googleProvider: GoogleAuthProvider | null = null;

if (typeof window !== 'undefined') {
  try {
    firebaseApp = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
    firebaseAuth = getAuth(firebaseApp);
    googleProvider = new GoogleAuthProvider();
    firestoreDb = getFirestore(firebaseApp);
  } catch (e) {
    console.error('Firebase initialization failed:', e);
  }
}

export { firebaseApp, firebaseAuth, googleProvider, firestoreDb };
