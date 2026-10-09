import { contextBridge, ipcRenderer } from 'electron';
import type { WorkbenchBridge } from './renderer/types.ts';

const bridge: WorkbenchBridge = {
  snapshot: () => ipcRenderer.invoke('workbench:snapshot'),
  createProject: () => ipcRenderer.invoke('workbench:createProject'),
  importConfiguration: () => ipcRenderer.invoke('workbench:importConfiguration'),
  authorizeModel: input => ipcRenderer.invoke('workbench:authorizeModel', input),
  prepareModelApproval: input => ipcRenderer.invoke('workbench:prepareModelApproval', input),
  createDemand: input => ipcRenderer.invoke('workbench:createDemand', input),
  readArtifact: input => ipcRenderer.invoke('workbench:readArtifact', input),
  knowledgeAction: input => ipcRenderer.invoke('workbench:knowledgeAction', input),
  command: input => ipcRenderer.invoke('workbench:command', input),
  sendMessage: input => ipcRenderer.invoke('workbench:sendMessage', input),
  subscribe: listener => {
    const handler = (_event: unknown, state: Parameters<typeof listener>[0]) => listener(state);
    ipcRenderer.on('workbench:state', handler);
    return () => ipcRenderer.removeListener('workbench:state', handler);
  },
};
// Never expose ipcRenderer, arbitrary channels, fs, process, shell, or eval.
contextBridge.exposeInMainWorld('workbench', Object.freeze(bridge));
