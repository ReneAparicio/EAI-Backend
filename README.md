# Practica Arduino UNO R4 WiFi: motor M1 y HC-SR04

## Archivos y ejecucion

Backend/server.js conserva Express, Render y autenticacion x-device-key.
Configurar DEVICE_KEY en el entorno; desde Backend ejecutar npm ci y npm start.
Pruebas: node --test Backend/integration.test.js Frontend/http.test.cjs desde la raiz.
Render: Root Directory Backend, build npm ci, start npm start, health /.
El estado vive en memoria: usar una sola instancia. Al reiniciar comienza manual/detenido.
No se realizaron despliegues.

## Contrato para aplicaciones moviles

Todas las rutas siguientes requieren x-device-key; GET / es publico.
- POST /motor: {"accion":"derecha"}, {"accion":"izquierda"} o {"accion":"detenido"}.
  Selecciona manual. Rechaza acciones antiguas o desconocidas con HTTP 400.
- POST /modo: {"modo":"manual"} o {"modo":"automatico"}. Reinicia accion a detenido.
- GET /comando: {"modo":"manual","accion":"detenido","revision":"UUID"}.
  revision cambia con cada orden valida de /motor o /modo y al reiniciar Render.
- POST /sensor: {"motor":"derecha","distancia":175}. Motor admite las mismas tres
  acciones; distancia es un numero finito no negativo o null cuando no hay lectura.
- GET /estado: {"modo":"manual","motor":"detenido","distancia":null,"conectado":false}.

El motor de /estado es la ultima telemetria, no una confirmacion inmediata de la orden.
conectado solo indica telemetria recibida hace menos de 10 segundos. Si es false,
el estado fisico es desconocido y la ultima distancia puede estar desactualizada.
Una aplicacion movil nativa puede consultar /estado por HTTPS con x-device-key.
No publicar la clave en JavaScript. La web movil existente consulta mediante PHP.

## Hostinger

Actualizar Frontend/api.php, Frontend/js/app.js e index.php juntos con el backend
 y el sketch: el proxy valida ahora derecha, izquierda y detenido. Las rutas,
los cuerpos JSON y el mecanismo de clave privada permanecen iguales.
Conservar bootstrap.php en public_html y config.php privado en su carpeta padre,
o configurar DEVICE_KEY en el entorno PHP. No copiar config.php a public_html.
Los botones ahora dicen DERECHA, IZQUIERDA y DETENER. No hay cambios de estilos.
El proxy expone estado, motor y modo; Arduino usa comando y sensor directamente.

## Arduino y conexion sin protoboard

Conservar DATA=8, CLOCK=4, LATCH=12, ENABLE=7 y PWM_M1=11 del shield L293D.
Un solo motor en M1: derecha activa bit 3, izquierda bit 2. M2 conserva PWM=3
siempre en cero y sus bits de direccion apagados. Velocidad: 100 de 255.
El sentido fisico depende del cableado: verificar sin carga; si esta invertido,
intercambiar los dos cables de M1 con la alimentacion apagada.
HC-SR04 conectado directamente con cables al shield/Arduino: VCC a 5V,
GND a GND, TRIG a A0 y ECHO a A1. No requiere protoboard.
Mantener alimentaciones de Arduino y motores separadas como en el montaje anterior,
con referencia GND comun y sin unir los positivos mediante el jumper del shield.

En automatico, calculado en Arduino, los intervalos son inclusivos:
- 150 a 200 cm: derecha.
- 100 a 140 cm: izquierda.
- Cualquier otro valor: detenido; incluye el hueco entre 140 y 150.
Sin eco, timeout de 25 ms o medida fuera de 2 a 400 cm: lectura invalida,
motor detenido en automatico y distancia null. Manual depende de la orden.

Se conservan WiFiS3, WiFiSSLClient, ArduinoHttpClient y ArduinoJson 7.
Copiar ArduinoRender/arduino_secrets.h.example como arduino_secrets.h y completar
localmente. El archivo privado existente no se modifica y esta en .gitignore.
No publicar ese archivo ni credenciales reales en repositorios o paquetes.

## Fallos y recuperacion

El sketch consulta /comando cada ciclo (pausa de 500 ms) y reporta cada 2 s.
WiFi perdido, HTTP distinto de 200, JSON invalido o comando desconocido detienen M1.
Tras un fallo bloquea la revision anterior, incluso en automatico: recuperar WiFi
no basta para reanudar. Enviar una nueva orden o seleccionar modo desde la app.
Si el fallo ocurre antes de la primera orden, bloquea la primera recibida y
requiere otra. Un reinicio de Render genera una revision nueva, pero comienza
siempre en manual/detenido. Al reiniciar Arduino, esperar conexion y enviar orden.

Las llamadas HTTPS son bloqueantes (conexion 5 s, respuesta 3 s); la parada ocurre
al detectar el fallo, no instantaneamente al perder la red. Los timeouts no
constituyen un limite total de latencia ni una parada independiente del firmware.
La telemetria puede quedar antigua si falla su envio. No se verifico hardware fisico.

## Compilacion

Con el core UNO R4 y bibliotecas instalados:
arduino-cli compile --fqbn arduino:renesas_uno:unor4wifi ArduinoRender
No cargar al Arduino ni publicar Render/Hostinger sin la confirmacion del usuario.

Verificacion local: pruebas HTTP de backend y frontend aprobadas; sintaxis PHP y
JavaScript aprobada. Se intento compilar con Arduino CLI para UNO R4 WiFi, pero
el entorno denego acceso a Arduino15/packages y escritura en Arduino15/tmp.
La compilacion del sketch queda pendiente en Arduino IDE o un entorno con acceso
al core instalado. No se ha cargado firmware ni probado el montaje fisico.
