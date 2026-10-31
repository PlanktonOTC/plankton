import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.dirname(fileURLToPath(import.meta.url));
const cache=path.join(root,'cache');await fs.mkdir(cache,{recursive:true});
const mime={'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.woff':'font/woff','.html':'text/html','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.mp4':'video/mp4'};
http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1:4174');
  if(req.method!=='GET'){res.writeHead(405);res.end();return;}
  if(url.pathname==='/'){
   let html=await fs.readFile(path.join(root,'source.html'),'utf8');
   html=html.replace('<head>','<head><meta name="robots" content="noindex,nofollow">');
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});res.end(html);return;
  }
  const relative=decodeURIComponent(url.pathname).replace(/^\/+/,''),local=path.resolve(root,relative);
  if(local.startsWith(root+path.sep)&&!url.search){
   try{const bytes=await fs.readFile(local);res.writeHead(200,{'Content-Type':mime[path.extname(local)]||'application/octet-stream'});res.end(bytes);return;}catch{}
  }
  const key=createHash('sha256').update(url.pathname+url.search).digest('hex');
  try{const meta=JSON.parse(await fs.readFile(path.join(cache,key+'.json'),'utf8'));const bytes=await fs.readFile(path.join(cache,key+'.bin'));res.writeHead(meta.status,{'Content-Type':meta.type});res.end(bytes);return;}catch{}
  const remote=await fetch('https://www.clearstreet.io'+url.pathname+url.search,{headers:{'User-Agent':'Mozilla/5.0 Reference Comparison'}});
  const bytes=Buffer.from(await remote.arrayBuffer());const type=remote.headers.get('content-type')||'application/octet-stream';
  if(remote.ok){await fs.writeFile(path.join(cache,key+'.bin'),bytes);await fs.writeFile(path.join(cache,key+'.json'),JSON.stringify({url:remote.url,type,status:remote.status}));}
  res.writeHead(remote.status,{'Content-Type':type,'Cache-Control':'no-cache'});res.end(bytes);
 }catch(e){res.writeHead(502,{'Content-Type':'text/plain'});res.end(String(e));}
}).listen(4174,'127.0.0.1',()=>console.log('Original Clear Street reference replay: http://127.0.0.1:4174/'));
