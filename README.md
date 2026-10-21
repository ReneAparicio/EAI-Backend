# API REST del carrito de dos motores

Node.js 24 y Express. Las variables del motor, modo y distancia viven en memoria;
un reinicio del servidor empieza en manual y detenido. Usar una sola instancia.

## Ejecutar y publicar manualmente

Desde Backend: npm ci, configurar DEVICE_KEY y ejecutar npm start.
Pruebas: npm test. Render: build npm ci, start npm start, health /.
Root Directory: Backend si el repositorio contiene todo el proyecto.
Render proporciona PORT y HTTPS. No se necesitan ALLOWED_ORIGINS ni servicios extra:
la pagina llama al proxy PHP del mismo sitio y el Arduino accede por HTTPS.

## Rutas y datos

GET / es publico. Las cinco rutas siguientes requieren x-device-key.
La clave debe coincidir en Render, PHP privado y arduino_secrets.h.

- GET /estado devuelve {"modo":"manual","motor":"detenido","distancia":null,"conectado":false}.
- POST /motor recibe accion: adelante, atras, izquierda, derecha o detenido.
  Ejemplo: {"accion":"adelante"}. DETENER sigue enviando detenido.
  Selecciona control manual y guarda la orden aunque el Arduino este desconectado.
  Devuelve el estado y accion. El motor informado solo cambia con una lectura del Arduino.
- POST /modo recibe {"modo":"manual"} o {"modo":"automatico"}.
  Guarda el modo y deja accion en detenido. Devuelve el estado.
- GET /comando devuelve {"modo":"manual","accion":"detenido"}.
- POST /sensor recibe {"motor":"detenido","distancia":null} y devuelve el estado.
  distancia es un numero no negativo en centimetros o null si no hay lectura.

conectado indica que /sensor recibio una lectura en los ultimos 10 segundos;
no comprueba un cable ni garantiza que la orden ya se haya ejecutado.
La orden permanece guardada hasta otro clic, un cambio de modo o un reinicio.
No hay caducidad ni descarte de ordenes por desconexion.

## Arduino y pagina

La web envia ordenes inmediatamente con fetch a api.php y consulta estado cada
segundo. Ningun boton se deshabilita. PHP agrega x-device-key sin exponerla al
navegador. No se cambian estilos ni elementos visuales.

Arduino consulta GET /comando, aplica la orden y espera 500 ms entre ciclos.
Envia motor y distancia a POST /sensor cada 2 segundos. ArduinoHttpClient con
WiFiSSLClient solicita mantener la conexion HTTPS para reutilizar TLS cuando
Render lo permita. Un fallo cierra ese cliente; la siguiente consulta reconecta.

El automatico se calcula en el Arduino: 50-90 cm izquierda, 100-150 derecha y
fuera de esos intervalos, incluido sensor sin eco, detenido. Limites inclusivos.
HC-SR04: TRIG=A0 y ECHO=A1. Shield: DATA=8, CLOCK=4, LATCH=12, ENABLE=7.
M1 conserva PWM_M1=11; M2 agrega PWM_M2=3. M1 es la rueda derecha y M2 la izquierda.
Adelante activa M1 bit 2 y M2 bit 1; atras, M1 bit 3 y M2 bit 4.
Izquierda activa M1 bit 2 y M2 bit 4; derecha, M1 bit 3 y M2 bit 1.
Los giros son sobre el eje, con las ruedas en sentidos opuestos.
Detener y los fallos de comunicacion desactivan ambos motores.
Comprobar la polaridad con las ruedas levantadas: adelante debe mover ambas
ruedas hacia delante. Si una gira al reves, invertir sus cables con la alimentacion apagada.
Las credenciales existentes no se modifican.

El Arduino detiene el motor al detectar WiFi perdido o un fallo HTTPS/JSON.
Las operaciones de red son bloqueantes: durante una llamada no procesa otra
orden ni comprueba WiFi. Los timeouts de conexion y respuesta no son una parada
independiente ni garantizan un limite total de latencia. Al recuperar la red,
se ejecuta la orden que siga guardada. Esta version no impide reanudarla.

## Pruebas

npm test prueba las cinco rutas, autenticacion, las cinco ordenes sin Arduino y telemetria.
node --test ../Frontend/http.test.cjs comprueba botones y carga privada de clave.
No se ha probado el motor fisico ni la latencia de Hostinger-Render-Arduino.
Ver Frontend/INTEGRACION-ARDUINO.md para actualizar las tres partes juntas.
