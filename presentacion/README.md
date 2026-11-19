# Presentación de AlertAR

Presentación animada (Three.js + GSAP) para la exposición de Ciudades Inteligentes (UCA).
Se avanza con → y se vuelve con ←.

- `presentacion/datos.md`: guion y datos de cada parte, con sus fuentes.
- `presentacion/visual/`: la presentación. `index.html` + `app.js` funcionan abriéndolos directo en el navegador.

## Compilar

```
cd presentacion/visual
npm install
npx esbuild src/main.js --bundle --format=iife --minify --loader:.wrl=text --outfile=app.js
```

## Publicar (Cloudflare Pages)

Copiar `index.html`, `app.js`, `diapos.css` e `img/` a una carpeta y subirla con
`npx wrangler pages deploy <carpeta> --project-name <proyecto>`.

Los modelos 3D de `modelos/` son de la biblioteca de KiCad (CC-BY-SA 4.0).
