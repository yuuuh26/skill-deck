import {build} from 'esbuild';
import {readFile,mkdir} from 'node:fs/promises';
const files={'index.html':'text/html;charset=utf-8','style.css':'text/css;charset=utf-8','app.js':'text/javascript;charset=utf-8','db.js':'text/javascript;charset=utf-8','backup.js':'text/javascript;charset=utf-8','cloud.js':'text/javascript;charset=utf-8','cloudflare/snapshot.js':'text/javascript;charset=utf-8','sw.js':'text/javascript;charset=utf-8','manifest.webmanifest':'application/manifest+json','icons/icon-192.png':'image/png','icons/icon-512.png':'image/png','icons/maskable-512.png':'image/png'};
const assets={};
for(const [file,type] of Object.entries(files)){
 let bytes=await readFile(file);
 if(file==='manifest.webmanifest'){const m=JSON.parse(bytes);m.id=m.start_url=m.scope='/';bytes=Buffer.from(JSON.stringify(m));}
 if(file==='index.html')bytes=Buffer.from(bytes.toString().replace('https://yuuuh26.github.io/skill-deck/</small>','https://skill-deck-cloud.dengana-10011212.workers.dev/</small>'));
 assets['/'+file]={type,base64:bytes.toString('base64')};
}
await mkdir('cloudflare/dist',{recursive:true});
await build({entryPoints:['cloudflare/site-worker.ts'],bundle:true,format:'esm',platform:'browser',minify:true,outfile:'cloudflare/dist/site-worker.js',plugins:[{name:'site-assets',setup(b){b.onResolve({filter:/^site-assets$/},()=>({path:'site-assets',namespace:'embedded'}));b.onLoad({filter:/.*/,namespace:'embedded'},()=>({contents:'export default '+JSON.stringify(assets),loader:'js'}));}}]});
