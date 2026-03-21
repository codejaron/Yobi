import type { IpcRenderer } from "electron";
import type { CompanionApi } from "@shared/ipc";

export const COGNITION_TICK_COMPLETED_CHANNEL = "cognition:tick-completed";
export const COGNITION_TICK_SUBSCRIBE_CHANNEL = "cognition:tick:subscribe";

export function createCognitionIpcApi(ipcRenderer: IpcRenderer): Pick<
  CompanionApi,
  | "getCognitionDebugSnapshot"
  | "triggerCognitionManualSpread"
  | "updateCognitionConfig"
  | "onCognitionTickCompleted"
> {
  return {
    getCognitionDebugSnapshot() {
      return ipcRenderer.invoke("cognition:getDebugSnapshot");
    },
    triggerCognitionManualSpread(input) {
      return ipcRenderer.invoke("cognition:triggerManualSpread", input ?? {});
    },
    updateCognitionConfig(input) {
      return ipcRenderer.invoke("cognition:updateConfig", input ?? {});
    },
    onCognitionTickCompleted(listener) {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => {
        listener(payload as never);
      };
      ipcRenderer.on(COGNITION_TICK_COMPLETED_CHANNEL, wrapped);
      ipcRenderer.send(COGNITION_TICK_SUBSCRIBE_CHANNEL);
      return () => {
        ipcRenderer.removeListener(COGNITION_TICK_COMPLETED_CHANNEL, wrapped);
      };
    }
  };
}
