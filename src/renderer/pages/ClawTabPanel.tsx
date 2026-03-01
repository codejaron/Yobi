import { ClawActionPane } from "@renderer/pages/claw-tab/ClawActionPane";
import { ClawChatPane } from "@renderer/pages/claw-tab/ClawChatPane";
import { useClawTabController } from "@renderer/pages/claw-tab/useClawTabController";

interface ClawTabPanelProps {
  active: boolean;
}

export function ClawTabPanel({ active }: ClawTabPanelProps) {
  const {
    chatItems,
    actionItems,
    expandedActions,
    logEnabled,
    setLogEnabled,
    draft,
    setDraft,
    connectionMessage,
    connectionBadge,
    sending,
    loadingHistory,
    historyError,
    chatBottomRef,
    actionBottomRef,
    clearActionLogs,
    toggleActionExpanded,
    handleAbort,
    handleSubmit
  } = useClawTabController(active);

  return (
    <div className="grid h-[calc(100vh-140px)] min-h-[680px] max-h-[900px] gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <ClawChatPane
        connectionBadge={connectionBadge}
        connectionMessage={connectionMessage}
        chatItems={chatItems}
        chatBottomRef={chatBottomRef}
        draft={draft}
        sending={sending}
        onDraftChange={setDraft}
        onSubmit={handleSubmit}
      />
      <ClawActionPane
        logEnabled={logEnabled}
        setLogEnabled={setLogEnabled}
        clearActionLogs={clearActionLogs}
        actionItems={actionItems}
        expandedActions={expandedActions}
        toggleActionExpanded={toggleActionExpanded}
        loadingHistory={loadingHistory}
        historyError={historyError}
        onAbort={handleAbort}
        actionBottomRef={actionBottomRef}
      />
    </div>
  );
}
