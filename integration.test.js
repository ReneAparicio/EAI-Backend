const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID, createHmac } = require('node:crypto');
const { WebSocket } = require('ws');
const origen = 'https://saddlebrown-ostrich-994927.hostingersite.com';
function permiso(clave) {
  const texto = Buffer.from(JSON.stringify({ origen, exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
  return texto + '.' + createHmac('sha256', clave).update(texto).digest('hex');
}
async function abrir(url, origin) {
  const socket = new WebSocket(url, origin ? { origin } : {});
  const mensajes = [];
  socket.on('message', raw => mensajes.push(JSON.parse(raw)));
  await once(socket, 'open');
  socket.enviar = datos => socket.send(JSON.stringify(datos));
  socket.esperar = async filtro => {
    const inicio = Date.now();
    while (Date.now() - inicio < 4000) {
      const posicion = mensajes.findIndex(filtro);
      if (posicion >= 0) return mensajes.splice(posicion, 1)[0];
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('No llego la respuesta esperada');
  };
  return socket;
}

test('rutas HTTP y protocolo WSS simple: control, estado, parada y reconexion', { timeout: 18000 }, async () => {
  const clave = randomUUID();
  const proceso = spawn(process.execPath, ['server.js'], { cwd: __dirname,
    env: { ...process.env, DEVICE_KEY: clave, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const sockets = [];
  let latidos;
  try {
    const puerto = await new Promise((resolve, reject) => {
      proceso.on('error', reject);
      proceso.stdout.on('data', d => { const m = d.toString().match(/puerto (\d+)/); if (m) resolve(m[1]); });
    });
    const base = 'http://127.0.0.1:' + puerto;
    const url = 'ws://127.0.0.1:' + puerto + '/ws';
    async function http(ruta, cuerpo, codigo = 200, key = clave) {
      const respuesta = await fetch(base + ruta, { method: cuerpo ? 'POST' : 'GET',
        headers: { 'x-device-key': key, 'Content-Type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
      assert.equal(respuesta.status, codigo, ruta);
      return respuesta.json();
    }
    await http('/');
    await http('/estado', null, 401, 'incorrecta');
    assert.deepEqual(await http('/estado'), { modo: 'manual', motor: 'detenido', distancia: null, conectado: false });
    await http('/motor', { accion: 'parar' }, 400);
    await http('/sensor', { distancia: -1, motor: 'detenido' }, 400);
    await http('/motor', { accion: 'izquierda' });
    assert.equal((await http('/comando')).accion, 'izquierda');
    await http('/modo', { modo: 'automatico' });
    await http('/motor', { accion: 'derecha' }, 409);
    await http('/motor', { accion: 'detenido' });
    await http('/modo', { modo: 'manual' });
    await http('/sensor', { distancia: 75, motor: 'detenido' });
    assert.equal((await http('/estado')).distancia, 75);

    const falso = await abrir(url); sockets.push(falso);
    const rechazado = once(falso, 'close');
    falso.enviar({ clave: 'incorrecta' });
    assert.equal((await rechazado)[0], 1008);
    const dispositivo = await abrir(url); sockets.push(dispositivo);
    // Autenticar tarde no debe consumir el plazo de los primeros latidos.
    await new Promise(resolve => setTimeout(resolve, 2200));
    dispositivo.enviar({ clave });
    const inicial = await dispositivo.esperar(x => Object.hasOwn(x, 'habilitado'));
    assert.deepEqual(inicial, { modo: 'manual', accion: 'detenido', habilitado: false, reto: 0 });
    let reto = 0;
    let motor = 'detenido';
    dispositivo.on('message', raw => {
      const d = JSON.parse(raw);
      assert.ok(Buffer.byteLength(raw) <= 120, 'Cabe en la biblioteca oficial del Arduino');
      if (d.habilitado && d.modo === 'manual') motor = d.accion;
      else motor = 'detenido';
    });
    const pulsar = () => dispositivo.enviar({ reto: ++reto, motor, distancia: null });
    pulsar();
    latidos = setInterval(pulsar, 250);
    await dispositivo.esperar(x => x.reto === 1);
    assert.equal((await http('/estado')).conectado, true);

    const pagina = await abrir(url, origen); sockets.push(pagina);
    pagina.enviar({ token: permiso(clave) });
    await pagina.esperar(x => x.conectado === true);
    const vidaPagina = setInterval(() => { if (pagina.readyState === 1) pagina.enviar({ pulso: true }); }, 1000);
    try {
      await http('/motor', { accion: 'derecha' }, 409);
      pagina.enviar({ accion: 'izquierda' });
      await dispositivo.esperar(x => x.accion === 'izquierda' && x.habilitado);
      await pagina.esperar(x => x.motor === 'izquierda');
      pagina.enviar({ accion: 'derecha' });
      await dispositivo.esperar(x => x.accion === 'derecha' && x.habilitado);
      await pagina.esperar(x => x.motor === 'derecha');
      pagina.enviar({ accion: 'detenido' });
      await dispositivo.esperar(x => x.accion === 'detenido' && !x.habilitado);
      await pagina.esperar(x => x.motor === 'detenido');
      pagina.enviar({ modo: 'automatico' });
      await dispositivo.esperar(x => x.modo === 'automatico' && x.habilitado);
      pagina.enviar({ accion: 'detenido' });
      await dispositivo.esperar(x => x.modo === 'automatico' && !x.habilitado);
      pagina.enviar({ modo: 'manual' });
      await dispositivo.esperar(x => x.modo === 'manual');
      pagina.enviar({ accion: 'izquierda' });
      await dispositivo.esperar(x => x.accion === 'izquierda');
      const cierrePagina = once(pagina, 'close');
      pagina.close();
      await cierrePagina;
      await dispositivo.esperar(x => x.accion === 'detenido' && !x.habilitado);
    } finally { clearInterval(vidaPagina); }

    clearInterval(latidos); latidos = null;
    await new Promise(resolve => setTimeout(resolve, 3600));
    assert.equal((await http('/estado')).conectado, false);
    const nuevo = await abrir(url); sockets.push(nuevo);
    nuevo.enviar({ clave });
    assert.equal((await nuevo.esperar(x => Object.hasOwn(x, 'habilitado'))).habilitado, false);
    nuevo.enviar({ reto: 4294967295, motor: 'detenido', distancia: 150 });
    const maximo = await nuevo.esperar(x => x.reto === 4294967295);
    assert.ok(Buffer.byteLength(JSON.stringify(maximo)) <= 120);
    assert.equal((await http('/estado')).distancia, 150);
  } finally {
    clearInterval(latidos);
    for (const socket of sockets) socket.terminate();
    const salida = once(proceso, 'exit');
    if (proceso.exitCode === null) { proceso.kill(); await salida; }
  }
});
