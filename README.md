# API Arduino: HTTP compatible y WebSocket persistente

Express + ws, Node.js 24.x. Ejecutar UNA instancia: el estado y las sesiones son
locales al proceso. Un reinicio empieza detenido. No se publico ni desplego esta
version desde el entorno de desarrollo.

## Ejecutar y probar

```powershell
npm.cmd ci
$env:DEVICE_KEY = 'TU_CLAVE_PRIVADA'
$env:ALLOWED_ORIGINS = 'https://saddlebrown-ostrich-994927.hostingersite.com'
npm.cmd test
npm.cmd start
```

En Render: servicio Node, build `npm ci`, start `npm start`, health `/`, Node 24.x,
`NODE_ENV=production`, `DEVICE_KEY` privada y `ALLOWED_ORIGINS` con los origenes
HTTPS de Hostinger, separados por comas, sin barra final. Render proporciona
PORT y termina TLS: WSS y HTTP utilizan el mismo servidor/puerto. No abrir otro
puerto. Si se publica el repositorio completo usar Root Directory `Backend`;
si el repositorio contiene solamente Backend, dejarlo vacio.

## Conexion de baja latencia

Navegador -- WSS /ws --> Render -- WSS /ws --> UNO R4 WiFi.
PHP interviene solo para emitir un permiso HMAC de un uso, valido 60 segundos
para abrir la sesion. El navegador nunca recibe DEVICE_KEY. El permiso esta
ligado al Origin de Hostinger. No es una nueva cuenta de usuario: mantiene el
acceso que ya proporciona la pagina. Solo se admite un controlador y un Arduino.
La clave privada debe coincidir en Render, PHP privado y firmware del Arduino.

ArduinoHttpClient WebSocketClient acepta un Client generico y se combina con
WiFiSSLClient de WiFiS3. El sketch incluye un adaptador que agrupa escrituras
TLS y presenta frames completos a su parser. Envia sus frames de texto
mascarados en una escritura para no depender del buffer TX de 128 bytes de la
biblioteca. No usa librerias para ESP32 ni desactiva la validacion TLS.

### Protocolo nuevo /ws

Primera trama del Arduino: `{tipo:"auth",rol:"arduino",clave:"..."}`.
El servidor responde `{tipo:"bienvenida",sesion:"UUID"}` y descarta ordenes previas.
El Arduino comienza detenido y cada 500 ms envia un pulso con los campos:
`tipo`, `sesion`, `reto` (contador creciente), `revision`, `motor`, `distancia`.
Una medicion ausente es null. Solo despues del primer pulso se informa conectado.

Respuesta/push del servidor: `tipo:"comando"`, `sesion`, `numero`, `reto`,
`modo`, `accion`, `revision`, `habilitado`. Los cuatro ultimos campos conservan
los valores de la API anterior. Se envia inmediatamente al pulsar un control,
y tambien en respuesta al reto del Arduino. No se renegocia TLS por cada orden.

El navegador autentica con `{tipo:"auth",rol:"control",token:"permiso PHP"}`.
Recibe `tipo:"estado"`, `epoca` y los campos HTTP modo/motor/distancia/conectado.
Envia `{tipo:"motor",accion:"izquierda|derecha|detenido",id:1,epoca:"..."}`
o `{tipo:"modo",modo:"manual|automatico",id:2,epoca:"..."}`. Los id crecen.
Envia `{tipo:"pulso"}` cada segundo. Recibe aceptado/error/aplicado por id.
`aplicado` confirma el estado de salida informado por Arduino, no mide el eje
con un encoder. La consola del navegador mide clic hasta esa confirmacion.

## Seguridad de movimiento

- Motor detenido durante WiFi, TLS y autenticacion. Sesion UUID nueva tras cada
  reconexion, sin recuperar acciones guardadas. Hace falta otro clic.
- Retos del propio Arduino: una orden de movimiento solo es aceptada mientras
  el reto tenga menos de un segundo. Repetir respuestas viejas no prolonga ese
  plazo. Una parada no necesita esperar un reto nuevo.
- Temporizador RA4M1 de 100 Hz: corta PWM_M1 aproximadamente al segundo sin una
  respuesta reciente. Funciona mientras una operacion del modem espera, siempre
  que el micro y sus interrupciones funcionen. Corta la activacion electrica;
  el motor puede tener inercia. No sustituye una parada fisica de emergencia.
- Render termina la sesion del Arduino a los 2 s sin pulso y la del controlador
  a los 3 s. Cerrar/ocultar la pagina envia STOP y cierra la sesion de control.
- STOP cambia epoca, revision y numero e invalida movimientos anteriores. Los
  clics no forman una cola de promesas y no se retransmiten tras reconectar.
  No es posible adelantar un paquete que ya este en transito por internet.
- Un segundo controlador es rechazado; cerrar la otra pestaña primero.

## Rutas HTTP conservadas

GET / publico. GET /estado, POST /motor, POST /modo, GET /comando (incluido
sincronizar=1) y POST /sensor siguen requiriendo x-device-key y conservan los
campos de entrada y salida. El modo automatico se calcula en Arduino: 50-90 cm
izquierda, 100-150 derecha, otros/medicion invalida detenido.

Para evitar carreras entre el control nuevo y clientes antiguos, mientras hay
un controlador WSS se rechazan con 409 movimientos y cambios de modo por HTTP.
STOP HTTP siempre es aceptado, incluso en automatico. Mientras el Arduino usa
WSS su telemetria HTTP devuelve 409; GET /comando no puede simular su presencia.
Sin clientes WSS se conserva el funcionamiento HTTP anterior, incluida la
expiracion de presencia a 10 s y la revision opcional de /sensor. Una reconexion
WSS siempre descarta cualquier orden HTTP que hubiera quedado pendiente.

## Verificacion y limites

`npm test` inicia servidores y clientes WSS simulados con claves efimeras. Prueba
HTTP, autenticacion, STOP ante mensajes atrasados, confirmacion, desconexion,
heartbeat del controlador, sesion nueva y rechazo de permisos reutilizados.
Pruebas locales en Node 25.6.0 (Render debe usar el 24.x declarado).
El objetivo de 300 ms debe medirse en el montaje real. Dos enlaces a internet,
la region de Render, el hotspot y la carga del modem pueden superarlo. WSS
elimina TLS repetido y polling, pero no garantiza tiempo real. Ante una
interrupcion el sistema se detiene, no acumula ordenes para despues.

Referencias: https://render.com/docs/websocket y el codigo oficial
https://github.com/arduino-libraries/ArduinoHttpClient/blob/master/src/WebSocketClient.h
