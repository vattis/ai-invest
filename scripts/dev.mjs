import http from 'node:http';
import { promises as fs } from 'node:fs';
import handler from '../api/index.js';
const types={'index.html':'text/html; charset=utf-8','app.js':'text/javascript; charset=utf-8','style.css':'text/css; charset=utf-8'};
const server=http.createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname.startsWith('/api/'))return handler(req,res);
  const file=pathname==='/'?'index.html':pathname.slice(1);
  if(!Object.hasOwn(types,file)){res.statusCode=404;return res.end('Not found');}
  res.setHeader('Content-Type',types[file]);res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.end(await fs.readFile(new URL(`../web/${file}`,import.meta.url)));
});
server.listen(Number(process.env.PORT)||3000,'127.0.0.1',()=>console.log(`Local: http://localhost:${server.address().port}`));
