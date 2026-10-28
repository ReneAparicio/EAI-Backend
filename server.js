const express = require('express');
const { randomUUID } = require('node:crypto');

const app = express();
const clave = process.env.DEVICE_KEY;
if (!clave || !clave.trim()) throw new Error('Configurá DEVICE_KEY.');

let modo = 'manual';
let accion = 'detenido';
let motor = 'detenido';
let distancia = null;
let ultimaLectura = 0;
const acciones = ['derecha', 'izquierda', 'detenido'];
let revision = randomUUID();

function estado() {
  return { modo, motor, distancia, conectado: ultimaLectura > 0 && Date.now() - ultimaLectura < 10000 };
}

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const arduinoRoute = (req.method === 'GET' && req.path === '/comando') ||
    (req.method === 'POST' && req.path === '/sensor');
  if (arduinoRoute && req.get('x-device-key') !== clave) return res.status(401).json({ error: 'Clave inválida.' });
  next();
});
app.use(express.json({ limit: '2kb' }));

app.get('/', (req, res) => res.json({ mensaje: 'API Arduino funcionando.' }));
app.get('/estado', (req, res) => res.json(estado()));
app.post('/motor', (req, res) => {
  console.log(`POST /motor | Acción: ${req.body?.accion}`);
  if (!req.body || !acciones.includes(req.body.accion)) return res.status(400).json({ error: 'Acción inválida.' });
  modo = 'manual';
  accion = req.body.accion;
  revision = randomUUID();
  res.json({ ...estado(), accion });
});
app.post('/modo', (req, res) => {
  if (!req.body || !['manual', 'automatico'].includes(req.body.modo)) return res.status(400).json({ error: 'Modo inválido.' });
  modo = req.body.modo;
  accion = 'detenido';
  revision = randomUUID();
  res.json(estado());
});
app.get('/comando', (req, res) => {
  console.log('GET /comando');
  res.json({ modo, accion, revision });
});
app.post('/sensor', (req, res) => {
  console.log(`POST /sensor | Distancia: ${req.body?.distancia} cm | Motor: ${req.body?.motor}`);
  const datos = req.body;
  if (!datos || !acciones.includes(datos.motor) || !(datos.distancia === null ||
      (typeof datos.distancia === 'number' && Number.isFinite(datos.distancia) && datos.distancia >= 0))) {
    return res.status(400).json({ error: 'Lectura inválida.' });
  }
  motor = datos.motor;
  distancia = datos.distancia;
  ultimaLectura = Date.now();
  res.json(estado());
});
app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));
app.use((error, req, res, next) => res.status(error.status || 500).json({ error: 'Petición no válida.' }));

const servidor = app.listen(process.env.PORT || 3000, '0.0.0.0', () => {
  console.log('API escuchando en el puerto ' + servidor.address().port);
});
