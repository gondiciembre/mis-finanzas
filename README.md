# Mis finanzas

App personal de gastos, cartera, RSU, notas estructuradas y monitor global. Las cotizaciones se traen en vivo de las APIs públicas de rendimientos.co (BYMA · data912) cada vez que se abre la app y cada minuto mientras está abierta. Los datos se guardan en Supabase y se sincronizan entre dispositivos.

Este repositorio no contiene datos personales: todo se guarda en tu proyecto de Supabase, protegido por login y Row Level Security.

## Puesta en marcha

1. Publicá esta carpeta en GitHub Pages (Settings → Pages → Deploy from a branch → `main` / root).
2. Abrí la URL de Pages y seguí la pantalla de configuración: crear proyecto en Supabase, ejecutar el SQL, desactivar *Confirm email* y pegar Project URL y clave anon.
3. Creá tu cuenta en la app e importá `mis-finanzas-datos.json`.
4. En Supabase → Authentication → Sign In / Providers, desactivá *Allow new users to sign up* para que nadie más pueda crear cuentas.
5. En el iPhone: abrí la URL en Safari → Compartir → Agregar a pantalla de inicio.
