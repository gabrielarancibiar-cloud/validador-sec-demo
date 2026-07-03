// VALEPAC - Barrera previa al portal
// Archivo: middleware.js
// Ubicación: raíz del repositorio, al mismo nivel que index.html, package.json y vercel.json

export const config = {
  matcher: '/:path*',
};

function unauthorized() {
  return new Response('Acceso privado VALEPAC', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="VALEPAC - Acceso privado"',
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function timingSafeEqual(a, b) {
  const aa = new TextEncoder().encode(String(a || ''));
  const bb = new TextEncoder().encode(String(b || ''));
  if (aa.length !== bb.length) return false;

  let diff = 0;
  for (let i = 0; i < aa.length; i++) {
    diff |= aa[i] ^ bb[i];
  }
  return diff === 0;
}

export default function middleware(request) {
  const expectedUser = process.env.PORTAL_GATE_USER;
  const expectedPass = process.env.PORTAL_GATE_PASS;

  // Si faltan variables, bloquea por seguridad.
  if (!expectedUser || !expectedPass) {
    return new Response('Falta configurar PORTAL_GATE_USER y PORTAL_GATE_PASS en Vercel.', {
      status: 500,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  const auth = request.headers.get('authorization') || '';

  if (!auth.startsWith('Basic ')) {
    return unauthorized();
  }

  let user = '';
  let pass = '';

  try {
    const decoded = atob(auth.slice(6));
    const separatorIndex = decoded.indexOf(':');
    user = decoded.slice(0, separatorIndex);
    pass = decoded.slice(separatorIndex + 1);
  } catch (_) {
    return unauthorized();
  }

  const okUser = timingSafeEqual(user, expectedUser);
  const okPass = timingSafeEqual(pass, expectedPass);

  if (!okUser || !okPass) {
    return unauthorized();
  }

  // Acceso correcto: continúa al portal normal.
  return;
}
