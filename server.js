const express = require('express');
const { randomUUID, timingSafeEqual } = require('node:crypto');

const app = express();
app.disable('x-powered-by');

const acciones = ['izquierda', 'derecha', 'detenido'];
const TIEMPO_CONEXION_MS = 10000;
let modo = 'manual';
let orden = 'detenido';
let motor = 'detenido';
let distancia = null;
let ultimaComunicacion = null;
let revision = randomUUID();
let habilitado = false;

function detener() {
  orden = 'detenido';
  motor = 'detenido';
  habilitado = false;
  revision = randomUUID();
}

function arduinoConectado() {
  if (ultimaComunicacion === null) {
    return false;
  }
  return Date.now() - ultimaComunicacion < TIEMPO_CONEXION_MS;
}

function obtenerEstado() {
  return {
    modo: modo,
    motor: motor,
    distancia: distancia,
    conectado: arduinoConectado()
  };
}

const clave = process.env.DEVICE_KEY;
if (!clave || !clave.trim()) {
  console.error('Configurá DEVICE_KEY antes de iniciar la API.');
  process.exit(1);
}
const claveEsperada = Buffer.from(clave);

app.use(function (req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (ultimaComunicacion !== null && !arduinoConectado()) {
    detener();
    ultimaComunicacion = null;
  }
  if (req.method === 'GET' && req.path === '/') {
    next();
    return;
  }
  const claveRecibida = Buffer.from(req.get('x-device-key') || '');
  let claveValida = false;
  if (claveRecibida.length === claveEsperada.length) {
    claveValida = timingSafeEqual(claveRecibida, claveEsperada);
  }
  if (!claveValida) {
    return res.status(401).json({ error: 'Clave de dispositivo inválida.' });
  }
  next();
});
app.use(express.json({ limit: '2kb' }));

app.get('/', function (req, res) {
  res.json({ mensaje: 'API Arduino funcionando.' });
});
app.get('/estado', function (req, res) {
  res.json(obtenerEstado());
});

app.post('/motor', function (req, res) {
  if (!req.body || !acciones.includes(req.body.accion)) {
    return res.status(400).json({ error: 'accion debe ser izquierda, derecha o detenido.' });
  }
  if (modo !== 'manual') {
    return res.status(409).json({ error: 'Los controles manuales están bloqueados en modo automático.' });
  }
  orden = req.body.accion;
  revision = randomUUID();
  habilitado = true;
  const respuesta = obtenerEstado();
  respuesta.accion = orden;
  respuesta.revision = revision;
  res.json(respuesta);
});

app.post('/modo', function (req, res) {
  if (!req.body || (req.body.modo !== 'manual' && req.body.modo !== 'automatico')) {
    return res.status(400).json({ error: 'modo debe ser manual o automatico.' });
  }
  if (modo !== req.body.modo) {
    modo = req.body.modo;
    detener();
    habilitado = true;
  }
  const respuesta = obtenerEstado();
  respuesta.revision = revision;
  res.json(respuesta);
});

app.get('/comando', function (req, res) {
  if (req.query.sincronizar !== undefined && req.query.sincronizar !== '1') {
    return res.status(400).json({ error: 'Usá sincronizar=1 o no enviés el parámetro.' });
  }
  if (req.query.sincronizar === '1') {
    detener();
  }
  ultimaComunicacion = Date.now();
  res.json({
    modo: modo,
    accion: orden,
    revision: revision,
    habilitado: habilitado
  });
});

app.post('/sensor', function (req, res) {
  const datos = req.body || {};
  let distanciaValida = false;
  if (datos.distancia === null) {
    distanciaValida = true;
  }
  if (typeof datos.distancia === 'number' && Number.isFinite(datos.distancia) && datos.distancia >= 0) {
    distanciaValida = true;
  }
  if (!distanciaValida || !acciones.includes(datos.motor)) {
    return res.status(400).json({ error: 'Enviá distancia numérica no negativa o null y un motor válido.' });
  }
  if (datos.revision !== undefined && datos.revision !== revision) {
    return res.status(409).json({
      error: 'Revisión antigua. Detené el motor y consultá /comando.',
      revision: revision
    });
  }
  distancia = datos.distancia;
  motor = datos.motor;
  ultimaComunicacion = Date.now();
  res.json(obtenerEstado());
});

app.use(function (req, res) {
  res.status(404).json({ error: 'Ruta no encontrada.' });
});
app.use(function (error, req, res, next) {
  const codigo = error.status || 500;
  let mensaje = 'Error del servidor.';
  if (codigo === 400) {
    mensaje = 'JSON inválido.';
  }
  if (codigo === 413) {
    mensaje = 'JSON demasiado grande.';
  }
  res.status(codigo).json({ error: mensaje });
});

const servidor = app.listen(process.env.PORT || 3000, '0.0.0.0', function () {
  console.log('API escuchando en el puerto ' + servidor.address().port);
});
