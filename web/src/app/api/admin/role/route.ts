import { NextResponse } from 'next/server';
import { getAdminApp } from '@/lib/firebaseAdmin';

export async function POST(request: Request) {
  const adminApp = getAdminApp();
  if (!adminApp) {
    return NextResponse.json({ error: 'Admin not configured' }, { status: 500 });
  }

  const body = (await request.json()) as { token?: string };
  const token = body.token;
  if (!token) {
    return NextResponse.json({ error: 'Missing token' }, { status: 400 });
  }

  try {
    const decoded = await adminApp.auth().verifyIdToken(token);
    const userDoc = await adminApp
      .firestore()
      .collection('users')
      .doc(decoded.uid)
      .get();

    return NextResponse.json({
      uid: decoded.uid,
      role: userDoc.data()?.role ?? 'viewer',
    });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}
