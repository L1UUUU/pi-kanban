import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
/** SDK runtime quiescence does not imply business completion or acceptance. */
export class PiLifecycle {
  settled=true;aborted=false;lowLevelEnds=0;
  accept(event:AgentSessionEvent){
    if(event.type==='agent_start'){this.settled=false;this.aborted=false;}
    if(event.type==='agent_end'){this.lowLevelEnds++;this.settled=false;}
    if(event.type==='agent_settled'){this.settled=true;this.aborted=event.aborted;}
  }
}
