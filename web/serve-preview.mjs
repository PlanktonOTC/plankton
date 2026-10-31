import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const args=process.argv.slice(2);
const port=Number(args[args.indexOf('--port')+1])||4173;
const root=path.resolve('dist');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.svg':'image/svg+xml','.woff2':'font/woff2','.mp4':'video/mp4','.webm':'video/webm','.json':'application/json'};
http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  const relative=decodeURIComponent(url.pathname).replace(/^\/+/, '');
  let file=path.resolve(root,relative||'index.html');
  if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403);res.end('Forbidden');return;}
  try{const stat=await fs.stat(file);if(stat.isDirectory())file=path.join(file,'index.html');}catch{if(path.extname(file)){res.writeHead(404);res.end('Not found');return;}file=path.join(root,'index.html');}
  const data=await fs.readFile(file);const contentType=types[path.extname(file)]||'application/octet-stream';
  const range=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  if(range){const start=Number(range[1]);const end=range[2]?Math.min(Number(range[2]),data.length-1):data.length-1;if(start>end||start>=data.length){res.writeHead(416,{'Content-Range':`bytes */${data.length}`});res.end();return;}res.writeHead(206,{'Content-Type':contentType,'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${data.length}`,'Content-Length':end-start+1});res.end(data.subarray(start,end+1));return;}
  res.writeHead(200,{'Content-Type':contentType,'Content-Length':data.length,'Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff'});res.end(data);
 }catch{res.writeHead(500);res.end('Preview could not read the requested file.');}
}).listen(port,'127.0.0.1',()=>console.log(`PLANKTON built preview: http://127.0.0.1:${port}`));
