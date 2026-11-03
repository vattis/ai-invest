import {writeFileSync} from 'node:fs';
if(process.argv.includes('app-server')){
  let buffer='';process.stdin.on('data',data=>{buffer+=data.toString();let i;
    while((i=buffer.indexOf('\n'))>=0){const e=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);if(!e.id)continue;
      const result=e.method==='account/read'?{account:{type:'chatgpt'}}:
        e.method==='model/list'?{data:[{id:'gpt-6-sol',model:'gpt-6-sol',supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:null}:
        e.method==='account/rateLimits/read'?{rateLimits:{primary:{usedPercent:10,windowDurationMins:300,resetsAt:2000000000}}}:{};
      console.log(JSON.stringify({id:e.id,result}));
    }
  });
}else if(process.env.TEST_CODEX_MODE==='hang')setInterval(()=>{},1000);
else{
  if(process.env.LOCAL_WORKER_TOKEN || process.env.LOCAL_CONTROL_URL) process.exit(7);
  process.stdin.resume();process.stdin.on('end',()=>{
    const args=process.argv.slice(2);
    if(!args.includes('--ignore-user-config')||!args.includes('shell_tool'))process.exit(3);
    const out=args[args.indexOf('--output-last-message')+1];
    writeFileSync(out,JSON.stringify({summary:'fixture',orders:[],lessons:[]}));
    console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:80,output_tokens:40,reasoning_output_tokens:20}}));
    if(process.env.TEST_CODEX_MODE==='fail'){console.log(JSON.stringify({type:'turn.failed'}));process.exitCode=1;}
  });
}
