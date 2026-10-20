const express = require('express');
const { randomUUID, timingSafeEqual, createHmac } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const clave = process.env.DEVICE_KEY;
if (!clave || !clave.trim()) {
  console.error('Configurá DEVICE_KEY antes de iniciar la API.');
  process.exit(1);
}
const origenes = (process.env.ALLOWED_ORIGINS ||
  'https://ghostwhite-elk-145882.hostingersite.com,https://saddlebrown-ostrich-994927.hostingersite.com')
  .split(',').map(valor => valor.trim());
const acciones = ['izquierda', 'derecha', 'detenido'];
const app = express();
app.disable('x-powered-by');
let modo = 'manual';
let orden = 'detenido';
let motor = 'detenido';
let distancia = null;
let ultimaComunicacion = null;
let revision = randomUUID();
let habilitado = false;
let epoca = randomUUID();
let numero = 0;
let arduino = null;
let controlador = null;
let confirmacion = null;
const permisosUsados = new Map();

function iguales(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function conectado() {
  if (arduino) return arduino.readyState === WebSocket.OPEN && arduino.listo && Date.now() - arduino.pulso < 2000;
  return ultimaComunicacion !== null && Date.now() - ultimaComunicacion < 10000;
}
function estado() {
  return { modo, motor, distancia, conectado: conectado() };
}
function enviar(socket, datos) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > 4096) return socket.terminate();
  socket.send(JSON.stringify(datos));
}
function publicarEstado() {
  enviar(controlador, { tipo: 'estado', epoca, ...estado() });
}
function comando() {
  return { modo, accion: orden, revision, habilitado };
}
function publicarComando() {
  if (!arduino || !arduino.listo) return;
  enviar(arduino, { tipo: 'comando', ...comando(), sesion: arduino.sesion, numero, reto: arduino.reto });
}
function detener() {
  orden = 'detenido';
  motor = 'detenido';
  habilitado = false;
  revision = randomUUID();
  epoca = randomUUID();
  numero++;
  confirmacion = null;
}
function ordenar(accion) {
  if (accion === 'detenido') detener();
  else {
    orden = accion;
    revision = randomUUID();
    numero++;
    habilitado = true;
  }
  publicarComando();
  publicarEstado();
}
function cambiarModo(nuevo) {
  if (modo !== nuevo) {
    detener();
    modo = nuevo;
    habilitado = true;
    publicarComando();
    publicarEstado();
  }
}
function sensorValido(datos) {
  return datos && (datos.distancia === null ||
    (typeof datos.distancia === 'number' && Number.isFinite(datos.distancia) && datos.distancia >= 0)) &&
    acciones.includes(datos.motor);
}
function validarPermiso(token, origen) {
  if (typeof token !== 'string' || token.length > 1500 || !origenes.includes(origen)) return false;
  const partes = token.split('.');
  if (partes.length !== 2) return false;
  const firma = createHmac('sha256', clave).update(partes[0]).digest('hex');
  if (!iguales(firma, partes[1])) return false;
  let datos;
  try { datos = JSON.parse(Buffer.from(partes[0], 'base64url')); } catch { return false; }
  const ahora = Math.floor(Date.now() / 1000);
  if (!datos || datos.rol !== 'control' || datos.origen !== origen || !Number.isInteger(datos.exp) ||
      datos.exp <= ahora || datos.exp > ahora + 90 || typeof datos.nonce !== 'string' ||
      permisosUsados.has(datos.nonce)) return false;
  permisosUsados.set(datos.nonce, datos.exp);
  return true;
}

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!arduino && ultimaComunicacion !== null && !conectado()) {
    detener();
    ultimaComunicacion = null;
    publicarEstado();
  }
  if (req.method === 'GET' && req.path === '/') return next();
  if (!iguales(req.get('x-device-key'), clave)) return res.status(401).json({ error: 'Clave de dispositivo inválida.' });
  next();
});
app.use(express.json({ limit: '2kb' }));
app.get('/', (req, res) => res.json({ mensaje: 'API Arduino funcionando.' }));
app.get('/estado', (req, res) => res.json(estado()));
app.post('/motor', (req, res) => {
  if (!acciones.includes(req.body?.accion)) return res.status(400).json({ error: 'accion debe ser izquierda, derecha o detenido.' });
  if (req.body.accion !== 'detenido' && (modo !== 'manual' || controlador)) {
    return res.status(409).json({ error: 'Movimiento HTTP bloqueado: modo automático o control WebSocket activo.' });
  }
  ordenar(req.body.accion);
  res.json({ ...estado(), accion: orden, revision });
});
app.post('/modo', (req, res) => {
  if (!['manual', 'automatico'].includes(req.body?.modo)) return res.status(400).json({ error: 'modo debe ser manual o automatico.' });
  if (controlador) return res.status(409).json({ error: 'Control WebSocket activo.' });
  cambiarModo(req.body.modo);
  res.json({ ...estado(), revision });
});
app.get('/comando', (req, res) => {
  if (req.query.sincronizar !== undefined && req.query.sincronizar !== '1') {
    return res.status(400).json({ error: 'Usá sincronizar=1 o no enviés el parámetro.' });
  }
  if (req.query.sincronizar === '1') {
    detener();
    publicarComando();
    publicarEstado();
  }
  if (!arduino) ultimaComunicacion = Date.now();
  res.json(comando());
});
app.post('/sensor', (req, res) => {
  if (!sensorValido(req.body)) return res.status(400).json({ error: 'Enviá distancia numérica no negativa o null y un motor válido.' });
  if (arduino) return res.status(409).json({ error: 'La telemetría activa utiliza WebSocket.' });
  if (req.body.revision !== undefined && req.body.revision !== revision) {
    return res.status(409).json({ error: 'Revisión antigua. Detené el motor y consultá /comando.', revision });
  }
  distancia = req.body.distancia;
  motor = req.body.motor;
  ultimaComunicacion = Date.now();
  res.json(estado());
});
app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));
app.use((error, req, res, next) => {
  const codigo = error.status || 500;
  let mensaje = 'Error del servidor.';
  if (codigo === 400) mensaje = 'JSON inválido.';
  if (codigo === 413) mensaje = 'JSON demasiado grande.';
  res.status(codigo).json({ error: mensaje });
});
const servidor = app.listen(process.env.PORT || 3000, '0.0.0.0', () => {
  console.log('API escuchando en el puerto ' + servidor.address().port);
});
const wss = new WebSocketServer({ server: servidor, path: '/ws', maxPayload: 2048, perMessageDeflate: false });
wss.on('connection', (socket, req) => {
  socket.rol = null;
  socket.pulso = Date.now();
  socket.ultimoId = 0;
  socket.on('error', () => socket.terminate());
  socket.on('message', (raw, binario) => {
    let datos;
    try { if (binario) throw new Error(); datos = JSON.parse(raw); } catch { return socket.close(1008, 'JSON invalido'); }
    if (!datos || typeof datos !== 'object') return socket.close(1008, 'Mensaje invalido');
    if (!socket.rol) {
      if (datos.tipo !== 'auth') return socket.close(1008, 'Autenticacion requerida');
      if (datos.rol === 'arduino' && !req.headers.origin && iguales(datos.clave, clave)) {
        if (arduino) return socket.close(1008, 'Ya hay un Arduino conectado');
        detener();
        ultimaComunicacion = null;
        arduino = socket;
        socket.rol = 'arduino';
        socket.sesion = randomUUID();
        socket.listo = false;
        socket.reto = 0;
        enviar(socket, { tipo: 'bienvenida', sesion: socket.sesion });
        publicarEstado();
      } else if (datos.rol === 'control' && validarPermiso(datos.token, req.headers.origin)) {
        if (controlador) return socket.close(1008, 'Otro controlador ya esta conectado');
        controlador = socket;
        socket.rol = 'control';
        detener();
        publicarComando();
        publicarEstado();
      } else socket.close(1008, 'Autenticacion invalida');
      return;
    }
    if (socket.rol === 'arduino') {
      if (socket !== arduino || datos.tipo !== 'pulso' || datos.sesion !== socket.sesion ||
          !Number.isSafeInteger(datos.reto) || datos.reto <= socket.reto || !sensorValido(datos)) {
        return socket.close(1008, 'Pulso invalido');
      }
      if (!socket.listo && datos.motor !== 'detenido') return socket.close(1008, 'Iniciar detenido');
      socket.listo = true;
      socket.reto = datos.reto;
      socket.pulso = Date.now();
      if (datos.revision === revision) {
        motor = datos.motor;
        distancia = datos.distancia;
        if (confirmacion && confirmacion.revision === revision) {
          enviar(confirmacion.socket, { tipo: 'aplicado', id: confirmacion.id, revision, motor });
          confirmacion = null;
        }
      }
      publicarComando();
      publicarEstado();
      return;
    }
    if (socket !== controlador) return socket.close(1008, 'Control reemplazado');
    if (datos.tipo === 'pulso') { socket.pulso = Date.now(); return enviar(socket, { tipo: 'pulso' }); }
    const esStop = datos.tipo === 'motor' && datos.accion === 'detenido';
    if (!Number.isSafeInteger(datos.id) || datos.id <= 0 || (!esStop && datos.id <= socket.ultimoId)) return;
    socket.ultimoId = Math.max(socket.ultimoId, datos.id);
    if (!esStop && datos.epoca !== epoca) return enviar(socket, { tipo: 'error', id: datos.id, error: 'Orden anterior a una parada. Volvé a pulsar.' });
    if (!esStop && !conectado()) return enviar(socket, { tipo: 'error', id: datos.id, error: 'Arduino desconectado.' });
    if (datos.tipo === 'motor' && acciones.includes(datos.accion)) {
      if (!esStop && modo !== 'manual') return enviar(socket, { tipo: 'error', id: datos.id, error: 'Modo automático activo.' });
      ordenar(datos.accion);
    } else if (datos.tipo === 'modo' && ['manual', 'automatico'].includes(datos.modo)) {
      cambiarModo(datos.modo);
    } else return enviar(socket, { tipo: 'error', id: datos.id, error: 'Orden no permitida.' });
    confirmacion = { socket, id: datos.id, revision };
    enviar(socket, { tipo: 'aceptado', id: datos.id, revision });
  });
  socket.on('close', () => {
    if (socket === arduino) {
      arduino = null;
      ultimaComunicacion = null;
      detener();
      publicarEstado();
    }
    if (socket === controlador) {
      controlador = null;
      detener();
      publicarComando();
    }
  });
});
setInterval(() => {
  const ahora = Date.now();
  for (const socket of wss.clients) {
    const limite = socket.rol === 'arduino' ? 2000 : 3000;
    if (ahora - socket.pulso > limite) socket.terminate();
  }
  for (const [nonce, exp] of permisosUsados) if (exp * 1000 < ahora) permisosUsados.delete(nonce);
}, 250).unref();
