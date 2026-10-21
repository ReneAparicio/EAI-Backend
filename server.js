const express = require('express');
const { timingSafeEqual, createHmac } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const clave = process.env.DEVICE_KEY;
if (!clave || !clave.trim()) throw new Error('Configurá DEVICE_KEY.');
const origenes = (process.env.ALLOWED_ORIGINS || 'https://ghostwhite-elk-145882.hostingersite.com,https://saddlebrown-ostrich-994927.hostingersite.com').split(',').map(x => x.trim());
const acciones = ['izquierda', 'derecha', 'detenido'];
const app = express();
let modo = 'manual';
let accion = 'detenido';
let habilitado = false;
let motor = 'detenido';
let distancia = null;
let ultimaLectura = 0;
let arduino = null;
let pagina = null;

function iguales(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function estado() {
  return { modo, motor, distancia, conectado: ultimaLectura > 0 && Date.now() - ultimaLectura < 3000 };
}
function enviar(socket, datos) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    if (socket.bufferedAmount > 2048) socket.terminate();
    else socket.send(JSON.stringify(datos));
  }
}
function comando(reto = 0) { return { modo, accion, habilitado, reto }; }
function publicar() {
  if (arduino) enviar(arduino, comando(arduino.reto));
  enviar(pagina, estado());
}
function detener() { accion = 'detenido'; habilitado = false; publicar(); }
function ordenar(nueva) {
  if (nueva === 'detenido') detener();
  else { accion = nueva; habilitado = true; publicar(); }
}
function cambiarModo(nuevo) {
  if (modo !== nuevo) {
    modo = nuevo;
    accion = 'detenido';
    habilitado = true;
    publicar();
  }
}
function sensorValido(datos) {
  return datos && acciones.includes(datos.motor) && (datos.distancia === null ||
    (typeof datos.distancia === 'number' && Number.isFinite(datos.distancia) && datos.distancia >= 0));
}
function permisoValido(token, origen) {
  if (typeof token !== 'string' || !origenes.includes(origen)) return false;
  const partes = token.split('.');
  if (partes.length !== 2) return false;
  const firma = createHmac('sha256', clave).update(partes[0]).digest('hex');
  if (!iguales(firma, partes[1])) return false;
  try {
    const permiso = JSON.parse(Buffer.from(partes[0], 'base64url'));
    const ahora = Math.floor(Date.now() / 1000);
    return permiso.origen === origen && Number.isInteger(permiso.exp) && permiso.exp > ahora && permiso.exp <= ahora + 90;
  } catch { return false; }
}

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (req.method === 'GET' && req.path === '/') return next();
  if (!iguales(req.get('x-device-key'), clave)) return res.status(401).json({ error: 'Clave inválida.' });
  next();
});
app.use(express.json({ limit: '2kb' }));
app.get('/', (req, res) => res.json({ mensaje: 'API Arduino funcionando.' }));
app.get('/estado', (req, res) => res.json(estado()));
app.post('/motor', (req, res) => {
  const nueva = req.body?.accion;
  if (!acciones.includes(nueva)) return res.status(400).json({ error: 'Acción inválida.' });
  if (nueva !== 'detenido' && (modo !== 'manual' || pagina)) return res.status(409).json({ error: 'Control manual HTTP no disponible.' });
  ordenar(nueva);
  res.json({ ...estado(), accion });
});
app.post('/modo', (req, res) => {
  if (!['manual', 'automatico'].includes(req.body?.modo)) return res.status(400).json({ error: 'Modo inválido.' });
  if (pagina) return res.status(409).json({ error: 'La página controla por WebSocket.' });
  cambiarModo(req.body.modo);
  res.json(estado());
});
app.get('/comando', (req, res) => {
  if (req.query.sincronizar === '1') detener();
  else if (req.query.sincronizar !== undefined) return res.status(400).json({ error: 'Usá sincronizar=1.' });
  res.json(comando());
});
app.post('/sensor', (req, res) => {
  if (!sensorValido(req.body)) return res.status(400).json({ error: 'Lectura inválida.' });
  if (arduino) return res.status(409).json({ error: 'Arduino conectado por WebSocket.' });
  motor = req.body.motor;
  distancia = req.body.distancia;
  ultimaLectura = Date.now();
  res.json(estado());
});
app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));
app.use((error, req, res, next) => res.status(error.status || 500).json({ error: 'Petición no válida.' }));
const servidor = app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('API escuchando en el puerto ' + servidor.address().port));
const wss = new WebSocketServer({ server: servidor, path: '/ws', maxPayload: 2048, perMessageDeflate: false });
wss.on('connection', (socket, req) => {
  socket.visto = Date.now();
  socket.reto = 0;
  socket.on('error', () => socket.terminate());
  socket.on('message', (raw, binario) => {
    let datos;
    try { if (binario) throw new Error(); datos = JSON.parse(raw); }
    catch { return socket.close(1008, 'JSON invalido'); }
    if (!datos || typeof datos !== 'object') return socket.close(1008, 'Mensaje invalido');
    if (!socket.autenticado) {
      if (!req.headers.origin && iguales(datos.clave, clave) && !arduino) {
        accion = 'detenido';
        habilitado = false;
        ultimaLectura = 0;
        arduino = socket;
      } else if (!pagina && permisoValido(datos.token, req.headers.origin)) {
        pagina = socket;
        detener();
      } else return socket.close(1008, 'Acceso no permitido');
      socket.autenticado = true;
      socket.visto = Date.now();
      publicar();
      return;
    }
    if (socket === arduino) {
      if (!sensorValido(datos) || !Number.isSafeInteger(datos.reto) || datos.reto <= socket.reto) return socket.close(1008, 'Pulso invalido');
      socket.reto = datos.reto;
      socket.visto = ultimaLectura = Date.now();
      motor = datos.motor;
      distancia = datos.distancia;
      publicar();
    } else if (socket === pagina) {
      socket.visto = Date.now();
      if (datos.pulso === true) return enviar(socket, estado());
      if (acciones.includes(datos.accion) && (modo === 'manual' || datos.accion === 'detenido')) ordenar(datos.accion);
      else if (['manual', 'automatico'].includes(datos.modo)) cambiarModo(datos.modo);
      else return enviar(socket, { error: 'Orden no permitida.' });
    }
  });
  socket.on('close', () => {
    if (socket === arduino) { arduino = null; ultimaLectura = 0; motor = 'detenido'; detener(); }
    if (socket === pagina) { pagina = null; detener(); }
  });
});
setInterval(() => {
  for (const socket of wss.clients) {
    const limite = socket === arduino ? 3000 : 5000;
    if (Date.now() - socket.visto > limite) socket.terminate();
  }
}, 500).unref();
