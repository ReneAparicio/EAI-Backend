# API del motor: version simplificada

Node.js 24, Express y ws. Una sola instancia: las variables viven en memoria.
Cada reinicio y reconexion del Arduino empieza con el movimiento deshabilitado.

## Ejecutar

Desde Backend: npm ci, configurar DEVICE_KEY y ejecutar npm start.
Pruebas: npm test. Render: build npm ci, start npm start, health /.
Si se publica todo el proyecto, Root Directory es Backend.
Render proporciona PORT y termina TLS. No hay otro puerto ni otro servicio.
ALLOWED_ORIGINS admite los origenes HTTPS de Hostinger separados por comas;
si no se configura se conservan los dos dominios existentes del proyecto.

## Comunicacion

Navegador y Arduino mantienen conexiones WSS a /ws. No se abre TLS por clic.
Una pagina y un Arduino a la vez. PHP entrega un permiso HMAC valido 60 segundos,
ligado al origen de la pagina; la clave permanente no llega al JavaScript.
La misma DEVICE_KEY debe estar en Render, PHP privado y arduino_secrets.h.

Primer mensaje Arduino: {"clave":"CLAVE_PRIVADA"}.
Pulso Arduino cada 500 ms: {"reto":1,"motor":"detenido","distancia":null}.
El reto es un contador creciente por conexion. La distancia es centimetros o null.
Respuesta y orden inmediata: {"modo":"manual","accion":"detenido","habilitado":false,"reto":1}.

Primer mensaje navegador: {"token":"PERMISO_PHP"}.
Orden: {"accion":"izquierda"}, {"accion":"derecha"} o {"accion":"detenido"}.
Modo: {"modo":"manual"} o {"modo":"automatico"}.
Pulso navegador cada segundo: {"pulso":true}.
Estado recibido: {"modo":"manual","motor":"detenido","distancia":null,"conectado":true}.
El motor mostrado es el informado por el Arduino, no una confirmacion mecanica.

## Parada y automatico

Un temporizador independiente del RA4M1 corta PWM_M1 como maximo aproximadamente
2 segundos desde el envio del pulso que autoriza el movimiento. Una respuesta
atrasada no reinicia ese plazo. Este corte sigue funcionando aunque una llamada
WiFi bloquee el programa, mientras el micro y sus interrupciones funcionen.
El contador permite descartar respuestas antiguas sin UUID, revisiones ni ACK.
Todos los mensajes destinados al Arduino son pequenos (menos de 126 bytes).
El adaptador TLS agrupa escrituras y entrega frames completos a ArduinoHttpClient.

Render cierra al Arduino tras 3 segundos sin pulso y a la pagina tras 5 segundos.
Cerrar u ocultar la pagina solicita detener. Toda reconexion descarta movimientos;
se necesita otro clic. Detener funciona tambien en automatico. Para volver a
activar automatico despues de Detener, pasar a manual y regresar a automatico.

El Arduino calcula el automatico: 50-90 cm izquierda, 100-150 derecha, otros o
lectura invalida detenido. Limites inclusivos. USAR_SENSOR esta desactivado hasta
conectar el HC-SR04 en TRIG=A0 y ECHO=A1 y habilitar esa constante.

## HTTP conservado

GET / es publico. Las otras rutas requieren x-device-key:
GET /estado devuelve el estado; POST /motor recibe accion;
POST /modo recibe modo; GET /comando devuelve modo, accion, habilitado y reto=0;
GET /comando?sincronizar=1 deshabilita movimiento; POST /sensor recibe motor y distancia.
No se conserva el protocolo antiguo de revisiones: actualizar el sketch y la web
junto con este servidor. El transporte principal del Arduino es ahora WSS.
Mientras una pagina controla por WSS, HTTP rechaza movimientos y cambios de modo
con 409. Detener siempre se admite. /sensor devuelve 409 si el Arduino usa WSS.

## Verificacion

npm test prueba HTTP y clientes WSS reales simulados: autenticacion, control,
estado, parada, expiracion, reconexion y tamano de mensajes para el Arduino.
No se probo el motor fisico ni se garantiza una latencia concreta por internet.
Nada se publica automaticamente. Ver Frontend/INTEGRACION-ARDUINO.md.
