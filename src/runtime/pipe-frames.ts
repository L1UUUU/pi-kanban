import type { Readable,Writable } from 'node:stream';
import { parsePiModelFrame } from './pi-channel.ts';
import { RuntimeError } from './types.ts';

const MAX=1024*1024;
/** Bounded length-prefixed private-handle codec. Tool stdout is never a control frame.
 * Native handles must already be verified; this codec itself is not authentication. */
export class PrivateFrameDecoder {
  private buffered=Buffer.alloc(0);
  push(chunk:Uint8Array):Uint8Array[]{
    if(chunk.byteLength+this.buffered.byteLength>2*MAX+8)throw new RuntimeError('FRAME_BACKPRESSURE','Input buffer limit exceeded');
    this.buffered=Buffer.concat([this.buffered,Buffer.from(chunk)]);const frames:Uint8Array[]=[];
    while(this.buffered.length>=4){const length=this.buffered.readUInt32BE(0);if(length<1||length>MAX)throw new RuntimeError('FRAME_SIZE','Invalid private frame length');
      if(this.buffered.length<4+length)break;
      frames.push(this.buffered.subarray(4,4+length));this.buffered=this.buffered.subarray(4+length);
      if(frames.length>8)throw new RuntimeError('FRAME_BACKPRESSURE','Too many simultaneous private frames');
    }return frames;
  }
  finish(){if(this.buffered.length)throw new RuntimeError('FRAME_TRUNCATED','Private channel closed mid-frame');}
}
export function encodePrivateFrame(payload:Uint8Array):Buffer {
  if(payload.byteLength<1||payload.byteLength>MAX)throw new RuntimeError('FRAME_SIZE','Invalid private frame payload');
  const header=Buffer.alloc(4);header.writeUInt32BE(payload.byteLength);return Buffer.concat([header,Buffer.from(payload)]);
}
/** Host side: independent cancellation state remains responsive during slow output.
 * Call close() before native Job termination on stop/exit. */
export class PrivateModelPipeServer {
  private input:Readable;private output:Writable;private decoder=new PrivateFrameDecoder();private active=new Set<AbortController>();private closed=false;
  private handler:(frame:Uint8Array,signal:AbortSignal)=>Promise<unknown>;
  constructor(input:Readable,output:Writable,handler:(frame:Uint8Array,signal:AbortSignal)=>Promise<unknown>){
    this.input=input;this.output=output;this.handler=handler;
    input.on('data',(chunk:Buffer)=>{try{for(const frame of this.decoder.push(chunk)){if(this.active.size>=4)throw new RuntimeError('FRAME_BACKPRESSURE','Four model requests already pending');this.dispatch(frame);}}
      catch(error){this.close(error as Error);}});
    input.on('end',()=>{try{this.decoder.finish();this.close();}catch(error){this.close(error as Error);}});
    input.on('error',error=>this.close(error));output.on('error',error=>this.close(error));
    input.on('close',()=>this.close());output.on('close',()=>this.close());
  }
  private dispatch(frame:Uint8Array){
    if(this.closed)return;const {sequence}=parsePiModelFrame(frame);const controller=new AbortController();this.active.add(controller);
    void this.handler(frame,controller.signal).then(value=>this.reply({sequence,ok:true,value}),error=>this.reply({sequence,ok:false,error:error instanceof RuntimeError?error.code:'MODEL_CHANNEL_ERROR'}))
      .finally(()=>this.active.delete(controller)).catch(error=>this.close(error));
  }
  private reply(value:unknown){
    if(this.closed)return;
    const framed=encodePrivateFrame(Buffer.from(JSON.stringify(value)));
    if(this.output.writableLength+framed.length>2*MAX)throw new RuntimeError('FRAME_BACKPRESSURE','Response channel is not draining');
    this.output.write(framed);
  }
  close(reason:Error=new RuntimeError('CHANNEL_CLOSED','Private model channel closed')){
    if(this.closed)return;this.closed=true;for(const controller of this.active)controller.abort(reason);
    this.input.destroy();this.output.destroy();
  }
}
/** Worker side for the same inherited pipes. Closing cancels all pending calls;
 * no local abort is interpreted as a zero provider charge. */
export class PrivateModelPipeClient {
  private input:Readable;private output:Writable;private decoder=new PrivateFrameDecoder();private closed=false;
  private pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;cleanup:()=>void}>();
  constructor(input:Readable,output:Writable){
    this.input=input;this.output=output;
    input.on('data',(chunk:Buffer)=>{try{for(const raw of this.decoder.push(chunk)){
      const reply=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)) as {sequence:number;ok:boolean;value?:unknown;error?:string};
      if(!Number.isSafeInteger(reply.sequence)||typeof reply.ok!=='boolean')throw new RuntimeError('FRAME_FORMAT','Invalid model response');
      const pending=this.pending.get(reply.sequence);if(!pending)throw new RuntimeError('CHANNEL_REPLAY','Unknown or replayed response sequence');
      this.pending.delete(reply.sequence);pending.cleanup();if(reply.ok)pending.resolve(reply.value);else pending.reject(new RuntimeError(reply.error??'MODEL_CHANNEL_ERROR','Host rejected the model request'));
    }}catch(error){this.close(error as Error);}});
    input.on('end',()=>this.close());input.on('error',error=>this.close(error));output.on('error',error=>this.close(error));
    input.on('close',()=>this.close());output.on('close',()=>this.close());
  }
  send(frame:Uint8Array,signal:AbortSignal):Promise<unknown>{
    if(this.closed)return Promise.reject(new RuntimeError('CHANNEL_CLOSED','Private channel is closed'));
    const {sequence}=parsePiModelFrame(frame);signal.throwIfAborted();
    if(this.pending.size>=4||this.pending.has(sequence))return Promise.reject(new RuntimeError('CHANNEL_REPLAY','Duplicate or excessive pending request'));
    const encoded=encodePrivateFrame(frame);
    if(this.output.writableLength+encoded.length>2*MAX)return Promise.reject(new RuntimeError('FRAME_BACKPRESSURE','Private request pipe is not draining'));
    return new Promise((resolve,reject)=>{
      const abort=()=>this.close(new RuntimeError('MODEL_ABORTED','Worker requested cancellation; Host usage remains accountable'));
      signal.addEventListener('abort',abort,{once:true});this.pending.set(sequence,{resolve,reject,cleanup:()=>signal.removeEventListener('abort',abort)});
      this.output.write(encoded,error=>{if(error)this.close(error);});
    });
  }
  close(reason:Error=new RuntimeError('CHANNEL_CLOSED','Private model channel closed')){
    if(this.closed)return;this.closed=true;
    for(const pending of this.pending.values()){pending.cleanup();pending.reject(reason);}this.pending.clear();
    this.input.destroy();this.output.destroy();
  }
}
