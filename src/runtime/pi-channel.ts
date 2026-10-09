import { createHash,randomUUID,timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ModelBudgetLedger } from './budget.ts';
import { ModelBroker } from './model-broker.ts';
import type { BrokerMaterial,ProviderResponse } from './model-broker.ts';
import { RuntimeError } from './types.ts';

export type ModelPurpose='prompt'|'retry'|'compaction'|'auxiliary';
export interface PiModelRequest {version:1;type:'model.request';capability:string;runId:string;generation:string;sessionId:string;sequence:number;purpose:ModelPurpose;context:unknown}
export interface PiModelChannel {complete(context:unknown,purpose:ModelPurpose,signal:AbortSignal|undefined):Promise<ProviderResponse>}
const MAX_FRAME_BYTES=1024*1024;
const keys=['version','type','capability','runId','generation','sessionId','sequence','purpose','context'];
export function parsePiModelFrame(frame:Uint8Array):PiModelRequest {
  if(frame.byteLength===0||frame.byteLength>MAX_FRAME_BYTES)throw new RuntimeError('FRAME_SIZE','Model frame size exceeds channel bounds');
  let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(frame));}catch{throw new RuntimeError('FRAME_FORMAT','Invalid UTF-8 JSON model frame');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new RuntimeError('FRAME_FORMAT','Object frame required');
  const data=value as Record<string,unknown>;
  if(Object.keys(data).length!==keys.length||keys.some(key=>!(key in data))||Object.keys(data).some(key=>!keys.includes(key)))throw new RuntimeError('FRAME_FIELDS','Only model capability fields are accepted');
  if(data.version!==1||data.type!=='model.request'||!Number.isSafeInteger(data.sequence)||Number(data.sequence)<1||
    !['prompt','retry','compaction','auxiliary'].includes(String(data.purpose)))throw new RuntimeError('FRAME_FORMAT','Invalid model request metadata');
  for(const key of ['capability','runId','generation','sessionId'])if(typeof data[key]!=='string'||data[key].length<1||data[key].length>200)throw new RuntimeError('FRAME_FORMAT','Invalid bound identity');
  if(!data.context||typeof data.context!=='object'||Array.isArray(data.context)||!Array.isArray((data.context as Record<string,unknown>).messages))throw new RuntimeError('FRAME_CONTEXT','A normalized SDK transcript is required');
  return data as unknown as PiModelRequest;
}
function equal(a:string,b:string){const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&timingSafeEqual(aa,bb);}
/** Per-run Host endpoint. Construct it only after authenticated native handle association.
 * No serialized frame can choose a provider, endpoint, headers, credential, demand or spending grant.
 * Context authorization is not a semantic secret scanner: all readable Worker input must already
 * be inside the user-approved model data scope, enforced by the verified OS/resource boundary. */
export class HostPiBrokerEndpoint {
  private db:DatabaseSync;private ledger:ModelBudgetLedger;private broker:ModelBroker;
  private binding:{runId:string;generation:string;sessionId:string;capability:string;grantId:string;role:string;reserveTokens:number;reserveCostMicros:number};
  private authorizeContext:(material:BrokerMaterial,request:PiModelRequest)=>Promise<{decisionId:string}>;
  private authorizeRun:()=>void;
  constructor(options:{db:DatabaseSync;ledger:ModelBudgetLedger;broker:ModelBroker;
    binding:{runId:string;generation:string;sessionId:string;capability:string;grantId:string;role:string;reserveTokens:number;reserveCostMicros:number};
    authorizeContext:(material:BrokerMaterial,request:PiModelRequest)=>Promise<{decisionId:string}>;authorizeRun:()=>void}) {
    this.db=options.db;this.ledger=options.ledger;this.broker=options.broker;this.binding={...options.binding};
    this.authorizeContext=options.authorizeContext;this.authorizeRun=options.authorizeRun;
    if(!/^[a-f0-9]{64}$/.test(this.binding.capability))throw new RuntimeError('CAPABILITY_INVALID','256-bit private channel capability required');
    options.db.exec('CREATE TABLE IF NOT EXISTS pi_channel_sequences(run_id TEXT NOT NULL,generation TEXT NOT NULL,last_sequence INTEGER NOT NULL,PRIMARY KEY(run_id,generation)); CREATE TABLE IF NOT EXISTS pi_authorized_contexts(id TEXT PRIMARY KEY,sha256 TEXT NOT NULL,body TEXT NOT NULL,decision_id TEXT NOT NULL)');
  }
  readMaterial(id:string):BrokerMaterial {
    const row=this.db.prepare('SELECT * FROM pi_authorized_contexts WHERE id=?').get(id) as {id:string;sha256:string;body:string}|undefined;
    if(!row)throw new RuntimeError('MATERIAL_MISSING','No authorized context snapshot');return {id:row.id,sha256:row.sha256,text:row.body};
  }
  async handle(frame:Uint8Array,signal:AbortSignal):Promise<ProviderResponse> {
    const request=parsePiModelFrame(frame),bound=this.binding;
    if(!equal(request.capability,bound.capability)||request.runId!==bound.runId||request.generation!==bound.generation||request.sessionId!==bound.sessionId)
      throw new RuntimeError('CHANNEL_IDENTITY_DENIED','Model channel identity/generation mismatch');
    this.authorizeRun();
    // Claim sequence before asynchronous reads/authorization so concurrent replay cannot dispatch twice.
    this.db.exec('BEGIN IMMEDIATE');
    try{const prev=this.db.prepare('SELECT last_sequence FROM pi_channel_sequences WHERE run_id=? AND generation=?').get(bound.runId,bound.generation) as {last_sequence:number}|undefined;
      if(request.sequence!==(prev?.last_sequence??0)+1)throw new RuntimeError('CHANNEL_REPLAY','Out-of-order or replayed channel request');
      this.db.prepare('INSERT INTO pi_channel_sequences VALUES(?,?,?) ON CONFLICT(run_id,generation) DO UPDATE SET last_sequence=excluded.last_sequence').run(bound.runId,bound.generation,request.sequence);this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    const body=JSON.stringify(request.context),digest=createHash('sha256').update(body).digest('hex');
    const material={id:`pi-context:${bound.runId}:${bound.generation}:${request.sequence}:${digest}`,sha256:digest,text:body};
    const permission=await this.authorizeContext(material,request);
    if(!permission.decisionId)throw new RuntimeError('DATA_PERMISSION_MISSING','Host must link model context to existing explicit data permission');
    this.authorizeRun();signal.throwIfAborted();
    this.db.prepare('INSERT INTO pi_authorized_contexts VALUES(?,?,?,?)').run(material.id,digest,body,permission.decisionId);
    this.ledger.authorizeData({grantId:bound.grantId,decisionId:permission.decisionId,material},()=>{}); // Authority is the Host callback above, never the frame.
    const grant=this.ledger.getGrant(bound.grantId);
    return this.broker.request({id:randomUUID(),grantId:grant.id,runId:bound.runId,role:bound.role,purpose:request.purpose,
      provider:grant.provider,modelId:grant.modelId,destination:grant.destination,data:[{id:material.id,sha256:digest}],reserveTokens:bound.reserveTokens,reserveCostMicros:bound.reserveCostMicros},signal);
  }
}
/** Worker-side client. The transport is an inherited private handle bridge, not HTTP.
 * Tests use an in-process function with the exact same frame codec. */
export class FramedPiModelChannel implements PiModelChannel {
  private binding:{runId:string;generation:string;sessionId:string;capability:string};private sequence:number;
  private send:(frame:Uint8Array,signal:AbortSignal)=>Promise<ProviderResponse>;
  constructor(binding:{runId:string;generation:string;sessionId:string;capability:string},send:(frame:Uint8Array,signal:AbortSignal)=>Promise<ProviderResponse>,lastSequence=0){this.binding={runId:binding.runId,generation:binding.generation,sessionId:binding.sessionId,capability:binding.capability};this.send=send;this.sequence=lastSequence;}
  async complete(context:unknown,purpose:ModelPurpose,signal:AbortSignal|undefined){
    const frame=Buffer.from(JSON.stringify({version:1,type:'model.request',...this.binding,sequence:++this.sequence,purpose,context}));
    parsePiModelFrame(frame);return this.send(frame,signal??new AbortController().signal);
  }
}
