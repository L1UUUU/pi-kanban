import { createHash, randomUUID } from 'node:crypto';
import { ModelBudgetLedger } from './budget.ts';
import type { ReservationRequest } from './budget.ts';
import { RuntimeError } from './types.ts';

export interface BrokerMaterial { id:string; sha256:string; text:string }
export interface BoundedTransportRequest {
  requestId:string; provider:string; modelId:string; destination:string; credentialRef:string;
  materials:readonly BrokerMaterial[]; maxTokens:number; signal:AbortSignal;
}
export type BrokerJsonValue = null | boolean | number | string | BrokerJsonValue[] | {[key:string]:BrokerJsonValue};
export interface ProviderResponse { text:string; toolCalls?:{id:string;name:string;arguments:{[key:string]:BrokerJsonValue}}[]; usage?:{tokens:number;costMicros:number;source:string} }
/** This is trusted Host code, never a Worker-provided fetch callback or arbitrary URL proxy. */
export interface BoundedProviderTransport {
  readonly provider:string; readonly modelId:string; readonly destination:string;
  readonly mode:'synthetic-no-network'|'real-provider';
  send(request:BoundedTransportRequest):Promise<ProviderResponse>;
}
export class ModelBroker {
  private ledger:ModelBudgetLedger;
  private transport:BoundedProviderTransport;
  private readMaterial:(id:string)=>Promise<BrokerMaterial>;
  private authorizeRun:(runId:string,demandId:string,role:string)=>void;
  private allowReal:boolean;
  constructor(options:{ledger:ModelBudgetLedger;transport:BoundedProviderTransport;
    readMaterial:(id:string)=>Promise<BrokerMaterial>;authorizeRun:(runId:string,demandId:string,role:string)=>void;
    realChannelVerified?:boolean}) {
    this.ledger=options.ledger;this.transport=options.transport;this.readMaterial=options.readMaterial;
    this.authorizeRun=options.authorizeRun;this.allowReal=options.realChannelVerified===true;
  }
  async request(input:ReservationRequest,signal:AbortSignal):Promise<ProviderResponse> {
    const grant=this.ledger.getGrant(input.grantId);
    this.authorizeRun(input.runId,grant.demandId,input.role);
    if(this.transport.mode==='real-provider'&&!this.allowReal)throw new RuntimeError('CHANNEL_UNVERIFIED','Real provider channel has no verified isolation evidence');
    if(input.provider!==this.transport.provider||input.modelId!==this.transport.modelId||input.destination!==this.transport.destination)
      throw new RuntimeError('TRANSPORT_SCOPE_DENIED','Transport binding does not exactly match requested provider, model and endpoint');
    if(input.provider!==grant.provider||input.modelId!==grant.modelId||input.destination!==grant.destination||!grant.allowedRoles.includes(input.role))
      throw new RuntimeError('MODEL_SCOPE_DENIED','No matching bounded authorization');
    if(!input.data.length||input.data.some(item=>!grant.data.some(x=>x.id===item.id&&x.sha256===item.sha256)))
      throw new RuntimeError('DATA_SCOPE_DENIED','Unapproved input material');
    const materials:BrokerMaterial[]=[];
    for(const reference of input.data){
      const material=await this.readMaterial(reference.id);
      if(material.id!==reference.id || material.sha256!==reference.sha256 || createHash('sha256').update(material.text).digest('hex')!==reference.sha256)
        throw new RuntimeError('MATERIAL_CHANGED','Immutable model input does not match its authorized hash');
      materials.push(Object.freeze({...material}));
    }
    this.authorizeRun(input.runId,grant.demandId,input.role);
    signal.throwIfAborted();
    this.ledger.reserve(input); // Durable and synchronous before the first provider side effect.
    try {
      const result=await this.transport.send({requestId:input.id,provider:grant.provider,modelId:grant.modelId,
        destination:grant.destination,credentialRef:grant.credentialRef,materials:Object.freeze(materials),maxTokens:input.reserveTokens,signal});
      if(result.usage)this.ledger.report({reportId:randomUUID(),requestId:input.id,tokens:result.usage.tokens,costMicros:result.usage.costMicros,source:result.usage.source,final:true});
      else this.ledger.markUnknown(input.id);
      return result;
    } catch(error) {
      // Abort, disconnect, and rejected promises are not proof the provider charged zero.
      this.ledger.markUnknown(input.id);throw error;
    }
  }
}
