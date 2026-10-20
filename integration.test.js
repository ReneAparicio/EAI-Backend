const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID, createHmac } = require('node:crypto');
const { WebSocket } = require('ws');

const origen = 'https://saddlebrown-ostrich-994927.hostingersite.com';
function permiso(clave, cambios = {}) {
  const payload = Buffer.from(JSON.stringify({ rol: 'control', origen, exp: Math.floor(Date.now() / 1000) + 60,
    nonce: randomUUID(), ...cambios })).toString('base64url');
  return payload + '.' + createHmac('sha256', clave).update(payload).digest('hex');
}
async function abrir(base, opciones) {
  const socket = new WebSocket(base, opciones);
  const mensajes = [];
  socket.on('message', raw => mensajes.push(JSON.parse(raw)));
  await once(socket, 'open');
  socket.enviar = datos => socket.send(JSON.stringify(datos));
  socket.esperar = async (filtro, timeout = 3500) => {
    const inicio = Date.now();
    while (Date.now() - inicio < timeout) {
      const i = mensajes.findIndex(filtro);
      if (i >= 0) return mensajes.splice(i, 1)[0];
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('No llego el mensaje esperado. Tipos: ' + mensajes.map(x => x.tipo));
  };
  return socket;
}

test('HTTP y WSS: autenticacion, prioridad STOP, ACK, liveness y reconexion sin ordenes antiguas', { timeout: 20000 }, async () => {
  const clave = randomUUID();
  const child = spawn(process.execPath, ['server.js'], { cwd: __dirname,
    env: { ...process.env, DEVICE_KEY: clave, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let intervalo;
  const sockets = [];
  try {
    const port = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.stderr.on('data', d => reject(new Error(d.toString())));
      child.stdout.on('data', d => { const match = d.toString().match(/puerto (\d+)/); if (match) resolve(match[1]); });
    });
    const base = 'http://127.0.0.1:' + port;
    const wsurl = 'ws://127.0.0.1:' + port + '/ws';
    async function http(ruta, cuerpo, status = 200, key = clave) {
      const res = await fetch(base + ruta, { method: cuerpo ? 'POST' : 'GET', headers: {
        'x-device-key': key, 'Content-Type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
      assert.equal(res.status, status, ruta);
      return res.json();
    }
    await http('/');
    await http('/estado', null, 401, 'incorrecta');
    assert.deepEqual(await http('/estado'), { modo: 'manual', motor: 'detenido', distancia: null, conectado: false });
    await http('/motor', { accion: 'parar' }, 400);
    let cmd = await http('/comando?sincronizar=1');
    assert.equal(cmd.habilitado, false);
    await http('/motor', { accion: 'izquierda' });
    cmd = await http('/comando');
    await http('/sensor', { distancia: 75, motor: 'izquierda', revision: cmd.revision });
    assert.equal((await http('/estado')).conectado, true);
    await http('/modo', { modo: 'automatico' });
    await http('/motor', { accion: 'derecha' }, 409);
    await http('/motor', { accion: 'detenido' });
    await http('/modo', { modo: 'manual' });

    const sinAuth = await abrir(wsurl); sockets.push(sinAuth);
    const cerrado = once(sinAuth, 'close');
    sinAuth.enviar({ tipo: 'motor', accion: 'izquierda' });
    assert.equal((await cerrado)[0], 1008);
    const invalido = await abrir(wsurl, { origin: origen }); sockets.push(invalido);
    const rechazado = once(invalido, 'close');
    invalido.enviar({ tipo: 'auth', rol: 'control', token: permiso('clave-incorrecta') });
    assert.equal((await rechazado)[0], 1008);

    const dispositivo = await abrir(wsurl); sockets.push(dispositivo);
    dispositivo.enviar({ tipo: 'auth', rol: 'arduino', clave });
    const bienvenida = await dispositivo.esperar(x => x.tipo === 'bienvenida');
    assert.equal((await http('/estado')).conectado, false);
    let reto = 0;
    let revision = '';
    let motor = 'detenido';
    const pulsar = () => dispositivo.enviar({ tipo: 'pulso', sesion: bienvenida.sesion, reto: ++reto,
      revision, motor, distancia: null });
    dispositivo.on('message', raw => {
      const d = JSON.parse(raw);
      if (d.tipo === 'comando') { revision = d.revision; motor = d.habilitado && d.modo === 'manual' ? d.accion : 'detenido'; }
    });
    pulsar();
    intervalo = setInterval(pulsar, 100);
    const inicial = await dispositivo.esperar(x => x.tipo === 'comando');
    assert.equal(inicial.accion, 'detenido');
    assert.equal(inicial.habilitado, false);
    assert.equal((await http('/estado')).conectado, true);
    await http('/sensor', { distancia: 75, motor: 'detenido' }, 409);

    const token = permiso(clave);
    const navegador = await abrir(wsurl, { origin: origen }); sockets.push(navegador);
    navegador.enviar({ tipo: 'auth', rol: 'control', token });
    let estado = await navegador.esperar(x => x.tipo === 'estado');
    const heartbeat = setInterval(() => { if (navegador.readyState === 1) navegador.enviar({ tipo: 'pulso' }); }, 500);
    try {
      await http('/motor', { accion: 'izquierda' }, 409);
      const inicio = performance.now();
      navegador.enviar({ tipo: 'motor', id: 1, epoca: estado.epoca, accion: 'izquierda' });
      const aplicado = await dispositivo.esperar(x => x.tipo === 'comando' && x.accion === 'izquierda');
      assert.equal(aplicado.habilitado, true);
      console.log('Entrega local navegador-servidor-dispositivo (ms):', Math.round(performance.now() - inicio));
      await navegador.esperar(x => x.tipo === 'aplicado' && x.id === 1);
      const epocaAnterior = estado.epoca;
      navegador.enviar({ tipo: 'motor', id: 2, epoca: epocaAnterior, accion: 'detenido' });
      navegador.enviar({ tipo: 'motor', id: 3, epoca: epocaAnterior, accion: 'derecha' });
      await navegador.esperar(x => x.tipo === 'error' && x.id === 3);
      estado = await navegador.esperar(x => x.tipo === 'estado' && x.epoca !== epocaAnterior);
      cmd = await http('/comando');
      assert.equal(cmd.accion, 'detenido');
      assert.equal(cmd.habilitado, false);
      navegador.enviar({ tipo: 'motor', id: 4, epoca: estado.epoca, accion: 'derecha' });
      await dispositivo.esperar(x => x.tipo === 'comando' && x.accion === 'derecha');
      navegador.enviar({ tipo: 'modo', id: 5, epoca: estado.epoca, modo: 'automatico' });
      estado = await navegador.esperar(x => x.tipo === 'estado' && x.modo === 'automatico');
      navegador.enviar({ tipo: 'motor', id: 6, epoca: estado.epoca, accion: 'detenido' });
      await navegador.esperar(x => x.tipo === 'aceptado' && x.id === 6);
      assert.equal((await http('/comando')).habilitado, false);

      const replay = await abrir(wsurl, { origin: origen }); sockets.push(replay);
      const replayCerrado = once(replay, 'close');
      replay.enviar({ tipo: 'auth', rol: 'control', token });
      assert.equal((await replayCerrado)[0], 1008);
      clearInterval(intervalo);
      intervalo = null;
      await new Promise(resolve => setTimeout(resolve, 2300));
      assert.equal((await http('/estado')).conectado, false);
      const nuevo = await abrir(wsurl); sockets.push(nuevo);
      nuevo.enviar({ tipo: 'auth', rol: 'arduino', clave });
      const nuevaSesion = await nuevo.esperar(x => x.tipo === 'bienvenida');
      assert.notEqual(nuevaSesion.sesion, bienvenida.sesion);
      nuevo.enviar({ tipo: 'pulso', sesion: nuevaSesion.sesion, reto: 1, motor: 'detenido', distancia: null, revision: '' });
      const seguro = await nuevo.esperar(x => x.tipo === 'comando');
      assert.equal(seguro.accion, 'detenido');
      assert.equal(seguro.habilitado, false);
      const fueraDeSesion = once(nuevo, 'close');
      nuevo.enviar({ tipo: 'pulso', sesion: bienvenida.sesion, reto: 2, motor: 'detenido', distancia: null });
      assert.equal((await fueraDeSesion)[0], 1008);
    } finally { clearInterval(heartbeat); }
  } finally {
    clearInterval(intervalo);
    for (const s of sockets) s.terminate();
    const salida = once(child, 'exit');
    if (child.exitCode === null) { child.kill(); await salida; }
  }
});

test('perder el heartbeat del navegador detiene aunque Arduino siga conectado', { timeout: 10000 }, async () => {
  const clave = randomUUID();
  const child = spawn(process.execPath, ['server.js'], { cwd: __dirname,
    env: { ...process.env, DEVICE_KEY: clave, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let intervalo;
  const sockets = [];
  try {
    const port = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.stdout.on('data', d => { const m = d.toString().match(/puerto (\d+)/); if (m) resolve(m[1]); });
    });
    const url = 'ws://127.0.0.1:' + port + '/ws';
    const dispositivo = await abrir(url); sockets.push(dispositivo);
    dispositivo.enviar({ tipo: 'auth', rol: 'arduino', clave });
    const bienvenida = await dispositivo.esperar(x => x.tipo === 'bienvenida');
    let reto = 0;
    const pulso = () => dispositivo.enviar({ tipo: 'pulso', sesion: bienvenida.sesion, reto: ++reto,
      distancia: null, motor: 'detenido', revision: '' });
    pulso();
    intervalo = setInterval(pulso, 100);
    await dispositivo.esperar(x => x.tipo === 'comando');
    const control = await abrir(url, { origin: origen }); sockets.push(control);
    control.enviar({ tipo: 'auth', rol: 'control', token: permiso(clave) });
    const estado = await control.esperar(x => x.tipo === 'estado');
    control.enviar({ tipo: 'motor', id: 1, epoca: estado.epoca, accion: 'izquierda' });
    const movimiento = await dispositivo.esperar(x => x.tipo === 'comando' && x.accion === 'izquierda');
    const detenido = await dispositivo.esperar(x => x.tipo === 'comando' && !x.habilitado && x.numero > movimiento.numero, 5000);
    assert.equal(detenido.accion, 'detenido');
  } finally {
    clearInterval(intervalo);
    for (const s of sockets) s.terminate();
    const salida = once(child, 'exit');
    if (child.exitCode === null) { child.kill(); await salida; }
  }
});
