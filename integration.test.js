const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');

test('API HTTP: clave, ordenes sin Arduino, modos y lecturas reales', { timeout: 10000 }, async () => {
  const clave = randomUUID();
  const proceso = spawn(process.execPath, ['server.js'], {
    cwd: __dirname, env: { ...process.env, DEVICE_KEY: clave, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    const puerto = await new Promise((resolve, reject) => {
      proceso.on('error', reject);
      proceso.stdout.on('data', datos => {
        const resultado = datos.toString().match(/puerto (\d+)/);
        if (resultado) resolve(resultado[1]);
      });
      proceso.on('exit', codigo => reject(new Error('Servidor termino con codigo ' + codigo)));
    });
    async function pedir(ruta, cuerpo, codigo = 200, key = clave) {
      const respuesta = await fetch('http://127.0.0.1:' + puerto + ruta, {
        method: cuerpo ? 'POST' : 'GET',
        headers: { 'x-device-key': key, 'Content-Type': 'application/json' },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined
      });
      assert.equal(respuesta.status, codigo, ruta);
      return respuesta.json();
    }
    await pedir('/', null, 200, '');
    await pedir('/estado', null, 401, 'incorrecta');
    assert.deepEqual(await pedir('/estado'), {
      modo: 'manual', motor: 'detenido', distancia: null, conectado: false
    });
    for (const accion of ['derecha', 'izquierda', 'detenido']) {
      const estado = await pedir('/motor', { accion });
      assert.equal(estado.conectado, false);
      assert.equal(estado.motor, 'detenido', 'La orden no inventa el estado fisico');
      assert.deepEqual(await pedir('/comando'), { modo: 'manual', accion });
    }
    await pedir('/motor', { accion: 'parar' }, 400);
    await pedir('/modo', { modo: 'automatico' });
    assert.deepEqual(await pedir('/comando'), { modo: 'automatico', accion: 'detenido' });
    await pedir('/motor', { accion: 'derecha' });
    assert.deepEqual(await pedir('/comando'), { modo: 'manual', accion: 'derecha' });
    await pedir('/modo', { modo: 'otro' }, 400);
    await pedir('/modo', { modo: 'automatico' });
    const estado = await pedir('/sensor', { motor: 'izquierda', distancia: 75 });
    assert.deepEqual(estado, { modo: 'automatico', motor: 'izquierda', distancia: 75, conectado: true });
    assert.deepEqual(await pedir('/estado'), estado);
    assert.deepEqual(await pedir('/comando'), { modo: 'automatico', accion: 'detenido' });
    await pedir('/sensor', { motor: 'detenido', distancia: null });
    assert.equal((await pedir('/estado')).distancia, null);
    await pedir('/sensor', { motor: 'derecha', distancia: -1 }, 400);
    await pedir('/sensor', { motor: 'otro', distancia: 100 }, 400);
    await pedir('/sensor', { motor: 'derecha', distancia: '100' }, 400);
    await pedir('/no-existe', null, 404);
    const invalido = await fetch('http://127.0.0.1:' + puerto + '/motor', {
      method: 'POST', headers: { 'x-device-key': clave, 'Content-Type': 'application/json' }, body: '{'
    });
    assert.equal(invalido.status, 400);
  } finally {
    if (proceso.exitCode === null) {
      const salida = once(proceso, 'exit');
      proceso.kill();
      await salida;
    }
  }
});
