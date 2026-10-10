import { spawn } from "node:child_process";

export interface ProcessSmokeResult {
  exitCode:number;
  stdout:string;
  stderr:string;
  durationMs:number;
}

/**
 * After the child has exited, its stdio pipes are normally drained and "close"
 * fires immediately. A grandchild that inherited the pipes can keep them open
 * indefinitely, so we only wait this long for the remaining output.
 */
const STDIO_DRAIN_GRACE_MS=250;

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
    let drainTimer:NodeJS.Timeout|undefined;

    const finish=(fn:()=>void):void=>{
      if(settled) return;
      settled=true;
      clearTimeout(timer);
      if(drainTimer!==undefined) clearTimeout(drainTimer);
      // Release the pipes so a lingering grandchild cannot keep our event loop alive.
      child.stdout.destroy();
      child.stderr.destroy();
      fn();
    };

    const succeed=(code:number|null):void=>finish(()=>{
      resolve({
        exitCode:code??-1,
        stdout,stderr,
        durationMs:performance.now()-started,
      });
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data",(chunk:string)=>{stdout+=chunk;});
    child.stderr.on("data",(chunk:string)=>{stderr+=chunk;});

    child.once("error",error=>finish(()=>reject(error)));
    // "exit" can fire before the stdout/stderr pipes are drained (large output
    // would be truncated), so prefer "close" and only fall back after a grace.
    child.once("exit",code=>{
      if(settled) return;
      drainTimer=setTimeout(()=>succeed(code),STDIO_DRAIN_GRACE_MS);
    });
    child.once("close",code=>succeed(code));

    const timer=setTimeout(()=>{
      child.kill();
      finish(()=>reject(new Error(`Process smoke timed out after ${timeoutMs}ms`)));
    },timeoutMs);
  });
}
