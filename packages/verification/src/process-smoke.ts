import { spawn } from "node:child_process";

export interface ProcessSmokeResult {
  exitCode:number;
  stdout:string;
  stderr:string;
  durationMs:number;
}

export async function runProcessSmoke(input:{
  executable:string;
  args?:string[];
  cwd?:string;
  timeoutMs?:number;
  env?:NodeJS.ProcessEnv;
}):Promise<ProcessSmokeResult>{
  const started=performance.now();
  const timeoutMs=input.timeoutMs??20_000;

  return new Promise((resolve,reject)=>{
    const child=spawn(input.executable,input.args??[],{
      ...(input.cwd?{cwd:input.cwd}:{}),
      env:{...process.env,...input.env},
      windowsHide:true,
      stdio:["ignore","pipe","pipe"],
    });

    let stdout="";
    let stderr="";
    let settled=false;

    const finish=(fn:()=>void):void=>{
      if(settled) return;
      settled=true;
      clearTimeout(timer);
      fn();
    };

    child.stdout.on("data",(chunk:Buffer)=>stdout+=chunk.toString("utf8"));
    child.stderr.on("data",(chunk:Buffer)=>stderr+=chunk.toString("utf8"));

    child.once("error",error=>finish(()=>reject(error)));
    child.once("exit",code=>finish(()=>{
      resolve({
        exitCode:code??-1,
        stdout,stderr,
        durationMs:performance.now()-started,
      });
    }));

    const timer=setTimeout(()=>{
      child.kill();
      finish(()=>reject(new Error(`Process smoke timed out after ${timeoutMs}ms`)));
    },timeoutMs);
  });
}
