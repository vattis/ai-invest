import { promises as fs } from 'node:fs';
await fs.mkdir('dist',{recursive:true});
for(const file of ['index.html','app.js','style.css'])await fs.copyFile(`web/${file}`,`dist/${file}`);
console.log('Vercel 정적 화면 빌드 완료: dist/');
